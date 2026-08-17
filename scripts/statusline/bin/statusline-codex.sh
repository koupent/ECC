#!/usr/bin/env bash
# statusline 4 行目の codex ブロック用 — レート制限の取得ヘルパ兼キャッシュ読み取り。
#
# 2 つの顔を持つ。
#   1. **source される**  — statusline.sh が読み込み、キャッシュ読み取りと
#      背景更新の起動判定に使う。**この経路はプロセスを 1 つも作らない**
#      (パス解決の git 1 回を除く。描画のたびに走るため)
#   2. **--refresh で実行される** — codex app-server を叩いてキャッシュを更新する。
#      setsid で切り離された背景プロセスとして起動されるので、ここでは
#      プロセス数を気にしない
#
# **statusline.sh からは「読める場合だけ」読み込まれる。**このファイルが無い
# worktree でも statusline は従来どおり動き、codex ブロックが出ないだけになる。

# ---- 定数 ---------------------------------------------------------------

# キャッシュ形式のバージョン印。**1 行目がこれと一致しなければキャッシュ無しへ倒す。**
# 形式を変えたら上げる (古い形式を読んで壊れた表示を出さないため)。
AVCL_SL_CACHE_VERSION="v1"

# **app-server の JSON-RPC メソッド名はここ 1 箇所だけ。**
# experimental 扱いで版差がありうるので、散らすと追従先が分からなくなる。
AVCL_SL_CODEX_METHOD="account/rateLimits/read"

# クライアント識別子 (initialize で渡す)。取得元の切り分け用。
AVCL_SL_CLIENT_NAME="koute-ecc-statusline"
AVCL_SL_CLIENT_VERSION="1"

# 取得のデッドライン (秒)。**上流 (openai/codex tag rust-v0.146.0) の実装から決める。**
#
#   - app-server/src/request_processors/account_processor.rs の
#     get_account_rate_limits_response は tokio::join! で 2 呼び出しを待ち合わせ、
#     **外側にタイムアウトが無い**
#   - join 相手の RATE_LIMIT_RESET_DETAILS_REQUEST_TIMEOUT は 5s だが、
#     **タイムアウトしても成功応答へ降格して返る** — つまり
#     「正常な応答が 5 秒近くかかる」経路が仕様内にある。
#     **5 秒以下のデッドラインは正常な応答を切り捨てる**
#   - 上流自身が同種の口座系 read へ与えている予算は 10s
#     (RATE_LIMIT_RESET_REQUEST_TIMEOUT / ACCOUNT_TOKEN_USAGE_FETCH_TIMEOUT)
#   - usage フェッチ本体・HTTP 層・auth の proactive refresh はいずれも非有界
#
# 根拠を持つ最小域は「10s + 起動/ハンドシェイクのマージン」。実測の
# ハンドシェイク〜応答は 0.6s 程度なので 5s のマージンで足りる。
#
# **既定値は 10s を下回らせない。**下回ると上流的に正常な応答を切り捨てる。
# test-statusline.sh がこの床を機械検査している。
AVCL_SL_DEADLINE="${AVCL_SL_DEADLINE:-15}"

# lock の失効判定 (秒)。**プロセスが死んでも回収できるようにするための時刻ベース。**
# デッドラインより十分長く取る (取得中の lock を横取りしないため)。
AVCL_SL_LOCK_TTL="${AVCL_SL_LOCK_TTL:-60}"

# 値を淡色へ降格し経過時間を併記するしきい値 (秒)。
# **成功時の再取得間隔より十分長く取る** — 短いと通常運用で常時降格する。
AVCL_SL_STALE_AFTER="${AVCL_SL_STALE_AFTER:-900}"

# 再取得間隔 (秒)。状態ごとに変える。
# 成功: 使用量はエージェントを動かしたときしか変わらない
# 未認証: 再ログインをそこそこ早く拾う
# 未対応: 版差なので当面は諦める
# 失敗: 60s 起点で倍々、上限まで (1 回の空振りなら早く戻し、不通なら叩き続けない)
AVCL_SL_INTERVAL_OK="${AVCL_SL_INTERVAL_OK:-180}"
AVCL_SL_INTERVAL_UNAUTH="${AVCL_SL_INTERVAL_UNAUTH:-600}"
AVCL_SL_INTERVAL_UNSUPPORTED="${AVCL_SL_INTERVAL_UNSUPPORTED:-21600}"
AVCL_SL_INTERVAL_ERROR_BASE="${AVCL_SL_INTERVAL_ERROR_BASE:-60}"
AVCL_SL_INTERVAL_ERROR_MAX="${AVCL_SL_INTERVAL_ERROR_MAX:-1800}"

# 自分自身のパス。背景更新の再起動に使う (source 時点で確定させる)。
AVCL_SL_SELF="${BASH_SOURCE[0]}"

# ---- キャッシュの場所 ---------------------------------------------------
# **リポジトリの中に置かない。**worktree を複数使っていても 1 つに収束するよう
# git の共有ディレクトリ配下へ置く (state / incident と同じ考え方。
# フォーク固有の永続領域へ置き、製品リポジトリを汚さない。
AVCL_SL_CACHE_REL="ecc-koute/statusline-codex.cache"

# 描画側の解決。**プロセスを 1 つも作らない** — コマンド置換すら使わないよう
# 結果はグローバルへ入れる。git-common-dir は呼び出し側が既存の git 呼び出しで
# 取得済みのものを渡す (描画のたびに走るので、ここで git を増やさない)。
avcl_sl_set_cache_path() { # <git-common-dir>
  SL_CX_CACHE=""
  if [ -n "${AVCL_SL_CACHE_FILE:-}" ]; then
    SL_CX_CACHE="$AVCL_SL_CACHE_FILE"
    return 0
  fi
  [ -n "${1:-}" ] || return 1
  SL_CX_CACHE="$1/$AVCL_SL_CACHE_REL"
  return 0
}

# 取得側 (--refresh) の解決。背景プロセスなので git を呼んでよい。
# 通常は描画側が env で渡すので、ここへ来るのは直接起動されたときだけ。
avcl_sl_cache_path() { # [dir]
  if [ -n "${AVCL_SL_CACHE_FILE:-}" ]; then
    printf '%s' "$AVCL_SL_CACHE_FILE"
    return 0
  fi
  local common
  common="$(git -C "${1:-$PWD}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || return 1
  [ -n "$common" ] || return 1
  printf '%s/%s' "$common" "$AVCL_SL_CACHE_REL"
}

# ---- キャッシュ読み取り (プロセス生成ゼロ) ------------------------------
# 結果はグローバルへ入れる。**コマンド置換で呼ばない** — 子シェルで走るので
# 呼び出し元へ戻らない。プロセスを作らないことがこの関数の要件でもある。
#
# 未知のキーは黙って無視する (旧形式・将来形式を読んでも落ちない)。
# 値は読む側でも形式検査する。キャッシュは外部プロセスが書くファイルなので、
# 検査を書き手だけに置くと壊れた行がそのまま描画へ流れる。

avcl_sl_cache_clear() {
  SL_CX_STATUS=""; SL_CX_FETCHED=0; SL_CX_OK_AT=0; SL_CX_FAILS=0; SL_CX_ERR=""
  SL_CX_WINS=()
}

avcl_sl_cache_read() { # <cache-file>
  local f="${1:-}" line k v first=1 seen=""
  avcl_sl_cache_clear
  [ -n "$f" ] && [ -r "$f" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    if [ "$first" = 1 ]; then
      first=0
      # 版印が合わない = 形式が違う。壊れているのと同じ扱いでキャッシュ無しへ倒す。
      [ "$line" = "$AVCL_SL_CACHE_VERSION" ] || { avcl_sl_cache_clear; return 1; }
      continue
    fi
    k=${line%%=*}
    v=${line#*=}
    [ "$k" = "$line" ] && continue    # '=' を含まない行は無視
    # **既知キーの値が形式検査に落ちたら、その行を捨てずにキャッシュ全体を
    # 「無し」へ倒す。**行だけ無視すると既定値 (ok_at=0 など) へ静かに落ちて、
    # 「1970 年に成功した値」として常時降格表示になる。壊れた入力は壊れたと扱う。
    # 未知キーの無視は現行どおり (旧形式・将来形式への耐性)。
    case "$k" in
      status)  [[ $v =~ ^(ok|unauth|error|unsupported)$ ]] || { avcl_sl_cache_clear; return 1; }
               SL_CX_STATUS=$v; seen="$seen status" ;;
      fetched) [[ $v =~ ^[0-9]+$ ]] || { avcl_sl_cache_clear; return 1; }
               SL_CX_FETCHED=$v; seen="$seen fetched" ;;
      ok_at)   [[ $v =~ ^[0-9]+$ ]] || { avcl_sl_cache_clear; return 1; }
               SL_CX_OK_AT=$v; seen="$seen ok_at" ;;
      fails)   [[ $v =~ ^[0-9]+$ ]] || { avcl_sl_cache_clear; return 1; }
               SL_CX_FAILS=$v; seen="$seen fails" ;;
      err)     [[ $v =~ ^[a-z_]+$ ]] || { avcl_sl_cache_clear; return 1; }; SL_CX_ERR=$v ;;
      win)     [[ $v =~ ^[0-9]+(\.[0-9]+)?[[:space:]][0-9]+[[:space:]][0-9]+$ ]] \
                 || { avcl_sl_cache_clear; return 1; }
               SL_CX_WINS+=("$v") ;;
      *)       : ;;
    esac
  done < "$f"
  # **書き手が必ず生成するキーが 1 つでも欠けていたらキャッシュ無しへ倒す。**
  # 書き込み中断で切れたファイルは「status だけある有効なキャッシュ」に見えてしまい、
  # 欠けた値は既定値 (ok_at=0 = 1970 年に成功) として静かに使われる。
  # err と win は状態によって出ないので必須にしない。
  for k in status fetched ok_at fails; do
    case " $seen " in *" $k "*) : ;; *) avcl_sl_cache_clear; return 1 ;; esac
  done
  return 0
}

# ---- 再取得の判定 (プロセス生成ゼロ) ------------------------------------
# 0 を返したら取得を起動する。avcl_sl_cache_read の後に呼ぶ。
avcl_sl_should_refresh() { # <now>
  local now="${1:-0}" interval n
  case "${SL_CX_STATUS:-}" in
    ok)          interval=$AVCL_SL_INTERVAL_OK ;;
    unauth)      interval=$AVCL_SL_INTERVAL_UNAUTH ;;
    unsupported) interval=$AVCL_SL_INTERVAL_UNSUPPORTED ;;
    error)
      # 連続失敗回数で倍々にする。fails を見ないと 60s 固定で叩き続ける。
      interval=$AVCL_SL_INTERVAL_ERROR_BASE
      n=${SL_CX_FAILS:-1}
      while [ "$n" -gt 1 ] && [ "$interval" -lt "$AVCL_SL_INTERVAL_ERROR_MAX" ]; do
        interval=$(( interval * 2 )); n=$(( n - 1 ))
      done
      [ "$interval" -gt "$AVCL_SL_INTERVAL_ERROR_MAX" ] && interval=$AVCL_SL_INTERVAL_ERROR_MAX
      ;;
    *) return 0 ;;   # キャッシュ無し / 壊れている → 取得する
  esac
  # 時計が巻き戻った場合 (fetched が未来) は取得し直す。放置すると永久に更新されない。
  [ "${SL_CX_FETCHED:-0}" -gt "$now" ] && return 0
  [ $(( now - ${SL_CX_FETCHED:-0} )) -ge "$interval" ]
}

# ---- 背景更新の起動 -----------------------------------------------------
# **stdin / stdout / stderr をすべて切り離し、独立したセッションで起動する。**
# 継承させると、statusline の出力をコマンド置換で読む親が子の終了まで待たされ、
# 非同期にした意味が消える (仕様「非同期性はコマンド置換で計測する」の対象)。
#
# キャッシュのパスは env で渡す。描画側と取得側で $PWD が違っても
# 同じファイルを指すようにするため (再解決させない)。
avcl_sl_spawn_refresh() { # <cache-file>
  local cache="${1:-}"
  [ -n "$cache" ] || return 0
  [ -n "$AVCL_SL_SELF" ] && [ -r "$AVCL_SL_SELF" ] || return 0
  AVCL_SL_CACHE_FILE="$cache" setsid bash "$AVCL_SL_SELF" --refresh \
    </dev/null >/dev/null 2>&1 &
  disown 2>/dev/null || true
  return 0
}

# ---- ここから下は --refresh (背景プロセス) 側 ---------------------------

avcl_sl_now() { printf '%s' "${EPOCHSECONDS:-$(date +%s)}"; }

# codex の設定ディレクトリ。CODEX_HOME を尊重する。
avcl_sl_codex_home() { printf '%s' "${CODEX_HOME:-$HOME/.codex}"; }

# app-server を 3 通 (initialize → initialized → 本体) で叩き、窓を取り出す。
#
# **分類は後付けの条件分岐で決めない。**独立に観測できる 3 つの事実を先に確定させ、
# その組み合わせから一意に導く。条件分岐で決める形は、条件が 1 つ増えるたびに
# 別の意味へ丸め込む漏れを作る (実際に「起動しなかった」が「答えなかった」を
# 飲み込んでいた)。
#
#   started   … exec できたか (**出力の有無とは独立**。子の終了コードで見る)
#   resp      … 本体リクエスト (トップレベル id=1) への応答があったか
#   wins      … 応答から有効な窓を 1 件以上取り出せたか
#
#   started=0             → nostart     … 起動しなかった
#   started=1, resp なし  → noresponse  … 起動はしたが答えが来なかった
#   resp あり, wins なし  → unparsable  … 応答は来たが想定の形ではなかった (版差)
#   wins あり             → ok
#
# stdout の 1 行目が分類、ok のときだけ 2 行目以降が "used 窓長分 リセットepoch"。
avcl_sl_probe() { # <stderr 保存先>
  local errfile="${1:-/dev/null}" w pid line id resp="" deadline remain
  local ifd ofd child_rc=0 started=0 wins=""

  w="$(mktemp -d 2>/dev/null)" || { printf 'nostart\n'; return 0; }
  if ! mkfifo "$w/in" "$w/out" 2>/dev/null; then
    rm -rf "$w"; printf 'nostart\n'; return 0
  fi

  # setsid で新セッションへ置く。codex は npm の JS ラッパが native バイナリを
  # 子に持つので、親 PID だけ kill すると本体が残る。グループごと落とせるようにする。
  #
  # **`bash -c 'exec ...'` を挟むのは exec の成否を終了コードで観測するため。**
  # `setsid codex ...` を直に書くと、exec に失敗しても setsid 自身の終了コード
  # (1) になり、**「起動できなかった」を出力の有無からしか推測できなくなる**
  # (実測: bad shebang でも rc=0)。exec は同じ PID を保つのでプロセスは増えない。
  setsid bash -c 'exec codex app-server' <"$w/in" >"$w/out" 2>"$errfile" &
  pid=$!

  # **fifo は子を起動してから開く。**書き手を先に開くと読み手が現れるまで
  # open(2) がブロックして自己デッドロックする (実測で 2 分ハングした)。
  # 入力側は <> (O_RDWR) で開く — こちらは読み手の有無に関わらずブロックしない。
  # 出力側は < のまま。<> にすると自分が書き手になり、子が死んでも EOF が来ず、
  # 毎回デッドラインいっぱい待つことになる。
  # **fd の開閉を早期 return で分岐させない。**分岐させると「起動できたか」を
  # 観測する前に分類を書くことになり、また丸め込みが生まれる。
  local ifd_open=0 ofd_open=0
  if exec {ifd}<>"$w/in" 2>/dev/null; then ifd_open=1; fi
  if [ "$ifd_open" = 1 ] && exec {ofd}<"$w/out" 2>/dev/null; then ofd_open=1; fi

  if [ "$ofd_open" = 1 ]; then
    # **stdin は開いたまま保持する。**EOF を送ると応答が返る前にプロセスが終了する。
    printf '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"clientInfo":{"name":"%s","title":"%s","version":"%s"}}}\n' \
      "$AVCL_SL_CLIENT_NAME" "$AVCL_SL_CLIENT_NAME" "$AVCL_SL_CLIENT_VERSION" >&"$ifd"
    printf '{"jsonrpc":"2.0","method":"initialized"}\n' >&"$ifd"
    printf '{"jsonrpc":"2.0","id":1,"method":"%s","params":{}}\n' "$AVCL_SL_CODEX_METHOD" >&"$ifd"

    # 応答には通知が混ざる。**リクエスト id で目的の行を選別する。**
    #
    # **トップレベルの id で選ぶ。**行内の部分一致 (`"id":1,`) だと
    #   - 通知の params に入った `{"id":1}` を本体応答として誤選択し、
    #   - 空白を含む正当な `{"id": 1, ...}` を取り逃す。
    # ここは背景プロセス (--refresh) なので jq を使ってよい (描画経路ではない)。
    deadline=$(( ${EPOCHSECONDS:-$(date +%s)} + AVCL_SL_DEADLINE ))
    while :; do
      remain=$(( deadline - ${EPOCHSECONDS:-$(date +%s)} ))
      [ "$remain" -gt 0 ] || break
      IFS= read -r -t "$remain" -u "$ofd" line || break
      id="$(printf '%s\n' "$line" | jq -r 'if type == "object" and has("id")
        then (.id | tostring) else empty end' 2>/dev/null)"
      [ "$id" = 1 ] && { resp="$line"; break; }
    done
  fi

  [ "$ifd_open" = 1 ] && exec {ifd}>&-
  [ "$ofd_open" = 1 ] && exec {ofd}<&-
  # **デッドライン超過でも必ず殺す。**上流が非有界なので、放置すると
  # hang したプロセスがレンダリングのたびに積み上がる。
  # KILL まで送るのは、この直後の wait を有界にするため (TERM を無視する子だと
  # wait が返らず、背景プロセスが残り続ける)。read-only の probe なので
  # 落とす前に片付けるべき状態は無い。
  kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null
  kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null; child_rc=$?
  rm -rf "$w"

  # ---- 観測 1: 起動できたか (出力の有無とは独立) ----
  # exec に失敗した場合だけ 126 (実行不可) / 127 (見つからない) が返る。
  # 正常に起動していれば、自分で終了しても kill されても別の値になる。
  case "$child_rc" in 126|127) started=0 ;; *) started=1 ;; esac

  # ---- 観測 3: 有効な窓を 1 件以上取り出せたか ----
  # **「rateLimits がオブジェクトなら ok」にしない。**型が変わった応答
  # (usedPercent が文字列など) が ok として記録されると、仕様が明示的に
  # 避けたい「壊れた表示を出し続ける」状態になる。
  if [ -n "$resp" ]; then
    wins="$(printf '%s\n' "$resp" | jq -r '
      .result.rateLimits
      | [.primary, .secondary] | .[]
      | select(type == "object")
      | select((.usedPercent|type) == "number"
           and (.windowDurationMins|type) == "number"
           and (.resetsAt|type) == "number")
      | "\(.usedPercent) \(.windowDurationMins|floor) \(.resetsAt|floor)"' 2>/dev/null)"
  fi

  # ---- 分類は 3 つの観測から一意に決まる ----
  if   [ "$started" != 1 ]; then printf 'nostart\n'
  elif [ -z "$resp" ];      then printf 'noresponse\n'
  elif [ -z "$wins" ];      then printf 'unparsable\n'
  else                           printf 'ok\n%s\n' "$wins"
  fi
  return 0
}

# キャッシュを原子的に置き換える。同一ディレクトリの一時ファイルへ書いてから mv。
# **直書きしない** — 描画は毎秒走るので、書きかけを読ませない。
avcl_sl_cache_write() { # <cache> <status> <fetched> <ok_at> <fails> <err> <win...>
  local cache="$1" status="$2" fetched="$3" ok_at="$4" fails="$5" err="$6"; shift 6
  local dir tmp w
  dir="${cache%/*}"
  mkdir -p "$dir" 2>/dev/null || return 1
  tmp="$(mktemp "$dir/.statusline-codex.XXXXXX" 2>/dev/null)" || return 1
  {
    printf '%s\n' "$AVCL_SL_CACHE_VERSION"
    printf 'status=%s\n' "$status"
    printf 'fetched=%s\n' "$fetched"
    printf 'ok_at=%s\n' "$ok_at"
    printf 'fails=%s\n' "$fails"
    [ -n "$err" ] && printf 'err=%s\n' "$err"
    # **書けるのは検査を通った数値 3 つ組だけ。**認証トークンや
    # アカウント識別子は保存しない (そもそも取り出さない)。
    for w in "$@"; do
      [[ $w =~ ^[0-9]+(\.[0-9]+)?[[:space:]][0-9]+[[:space:]][0-9]+$ ]] || continue
      printf 'win=%s\n' "$w"
    done
  } > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }
  mv -f "$tmp" "$cache" 2>/dev/null || { rm -f "$tmp"; return 1; }
  return 0
}

avcl_sl_refresh() {
  local cache lock now mt age rc=0
  cache="$(avcl_sl_cache_path)" || return 1
  [ -n "$cache" ] || return 1
  mkdir -p "${cache%/*}" 2>/dev/null || return 1

  # 排他。mkdir は原子的なので lock として使える。
  # **プロセスが死んでも回収できるよう時刻ベースの失効判定を併用する。**
  lock="$cache.lock"
  now="$(avcl_sl_now)"
  if ! mkdir "$lock" 2>/dev/null; then
    mt="$(stat -c %Y "$lock" 2>/dev/null)" || mt=0
    [ -n "$mt" ] || mt=0
    age=$(( now - mt ))
    [ "$age" -ge "$AVCL_SL_LOCK_TTL" ] || return 0   # 生きている取得がある
    rm -rf "$lock" 2>/dev/null
    mkdir "$lock" 2>/dev/null || return 0
  fi
  # shellcheck disable=SC2064
  trap "rm -rf '$lock'" EXIT INT TERM

  # 直前の値を引き継ぐ (失敗しても「古い値を出し続けられる」ようにするため)。
  avcl_sl_cache_read "$cache" || true
  local prev_ok_at="${SL_CX_OK_AT:-0}" prev_fails="${SL_CX_FAILS:-0}"
  local prev_wins=(); [ "${#SL_CX_WINS[@]}" -gt 0 ] && prev_wins=("${SL_CX_WINS[@]}")

  # 認証情報が無いと事前に分かるなら、プローブを走らせず即座に未認証と判定する。
  if [ ! -r "$(avcl_sl_codex_home)/auth.json" ]; then
    avcl_sl_cache_write "$cache" unauth "$now" "$prev_ok_at" "$prev_fails" "" "${prev_wins[@]}"
    return 0
  fi

  command -v codex >/dev/null 2>&1 || return 0   # CLI 不在は描画側が毎回判定する

  local errtmp out kind wins line
  errtmp="$(mktemp 2>/dev/null)" || errtmp=/dev/null
  out="$(avcl_sl_probe "$errtmp")"
  kind="${out%%$'\n'*}"
  wins="${out#*$'\n'}"
  [ "$wins" = "$out" ] && wins=""

  now="$(avcl_sl_now)"
  if [ "$kind" = ok ]; then
    local arr=()
    while IFS= read -r line; do [ -n "$line" ] && arr+=("$line"); done <<< "$wins"
    avcl_sl_cache_write "$cache" ok "$now" "$now" 0 "" "${arr[@]}" || rc=1
  else
    # **失敗時に ok_at を進めない。**値の信頼度は経過時間の関数であって、
    # 直近の試行が成功したかどうかではない。
    local status=error
    [ "$kind" = unparsable ] && status=unsupported
    avcl_sl_cache_write "$cache" "$status" "$now" "$prev_ok_at" \
      $(( prev_fails + 1 )) "$kind" "${prev_wins[@]}" || rc=1
    # **失敗時の stderr を 1 件だけ上書き保存する** (追記にしない = 無制限に育たない)。
    # 表示には出さない。**今回が空でも上書きする** — 空だからと書かずに済ませると、
    # 「非空の失敗 → 空の失敗」の順で前回分が残り、最後の失敗の stderr でなくなる。
    if [ "$errtmp" != /dev/null ]; then
      tail -c 8192 "$errtmp" > "${cache%/*}/statusline-codex.err" 2>/dev/null || true
    fi
  fi
  [ "$errtmp" = /dev/null ] || rm -f "$errtmp"
  return $rc
}

# ---- 実行された場合のみ動く ---------------------------------------------
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -uo pipefail
  case "${1:-}" in
    --refresh) avcl_sl_refresh ;;
    *) printf 'usage: statusline-codex.sh --refresh\n' >&2; exit 1 ;;
  esac
fi
