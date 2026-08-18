#!/usr/bin/env bash
# Claude Code status line — ディレクトリ / repo・branch / コンテキスト / モデル /
# レート制限(提供元・窓ラベル・使用%・目安%・リセット時刻)。
# stdin の JSON を読み、4行（rate_limits 欠落時は3行）を出力する。
#
# 4 行目は Claude 本体と Codex を 1 行へ統合する。Codex 側は外部取得が
# 数百 ms〜数秒かかるので、**描画は必ずキャッシュを読むだけ**にして、
# 取得は切り離した背景プロセスへ出す (.claude/bin/statusline-codex.sh)。

input=$(cat)

# 必要フィールドを 1回の jq パスで「1行1値」取得（欠落は空行）。
# 改行区切り＋mapfile なら空フィールドも欠落せず位置がずれない
# （IFS=tab の read はタブが IFS 空白扱いで空フィールドを潰すため不可）。
mapfile -t F < <(printf '%s' "$input" | jq -r '
  (.workspace.current_dir // .cwd // ""),
  (.workspace.project_dir // ""),
  (.workspace.repo.name // ""),
  (.worktree.branch // .workspace.git_worktree // ""),
  (.context_window.used_percentage // 0 | floor),
  (.model.display_name // ""),
  (.effort.level // ""),
  (.rate_limits.five_hour.used_percentage // ""),
  (.rate_limits.five_hour.resets_at // ""),
  (.rate_limits.seven_day.used_percentage // ""),
  (.rate_limits.seven_day.resets_at // "")')
cwd=${F[0]}; project_dir=${F[1]}; repo_name=${F[2]}; wt_branch=${F[3]}
ctx_pct=${F[4]}; model=${F[5]}; effort=${F[6]}
rl5_pct=${F[7]}; rl5_reset=${F[8]}; rl7_pct=${F[9]}; rl7_reset=${F[10]}

# ANSI カラー
# **色語彙を増やさない。**4 行目の提供元ラベルは既存の 2 色を再利用する
# (claude = 3 行目のモデル名の色 / codex = 2 行目のリポジトリ名の色)。
# RED は rlseg が使っていた赤をここへ持ち上げただけ (バイトは同一)。
DIM=$'\033[2;37m'; CYAN=$'\033[36m'; GREEN=$'\033[32m'; BOLD=$'\033[1m'
MODEL=$'\033[35m'; SEP=$'\033[2;37m'; RST=$'\033[0m'; RED=$'\033[1;31m'

# codex のレート制限ヘルパ。**読める場合だけ読み込む。**
# 無い worktree でも statusline は従来どおりの行数で動き exit 0 になる
# (codex ブロックが出ないだけ)。
_sl_dir=${BASH_SOURCE[0]%/*}
[ "$_sl_dir" = "${BASH_SOURCE[0]}" ] && _sl_dir=.
# shellcheck source=./bin/statusline-codex.sh
[ -r "$_sl_dir/bin/statusline-codex.sh" ] && . "$_sl_dir/bin/statusline-codex.sh"

# 1行目: ディレクトリ（$HOME → ~）
case "$cwd" in
  "$HOME")   dir="~" ;;
  "$HOME"/*) dir="~${cwd#"$HOME"}" ;;
  *)         dir="$cwd" ;;
esac

# 2行目: repo / branch（branch は実コマンドで取得、worktree 名にフォールバック）
#
# **git の起動は 1 回にまとめる。**4 行目の codex キャッシュは
# <git-common-dir>/ecc-koute/ 配下にあり、その解決もここで済ませる
# （描画のたびに走るので、キャッシュを読むために git を増やさない）。
# --symbolic-full-name は detached HEAD で "HEAD" を返すので、refs/heads/ で
# 始まる場合だけ branch として採る = git branch --show-current と同じ結果になる。
gitout="$(git -C "$cwd" rev-parse --path-format=absolute \
  --git-common-dir --symbolic-full-name HEAD 2>/dev/null)"; git_rc=$?
git_common=${gitout%%$'\n'*}
head_ref=${gitout#*$'\n'}
[ "$head_ref" = "$gitout" ] && head_ref=""
branch=""
case "$head_ref" in refs/heads/*) branch=${head_ref#refs/heads/} ;; esac
# HEAD を解決できなかった repo（コミットがまだ無い等）だけ従来の経路へ落とす。
# git リポジトリでない場合はここへ来ない = プロセスは増えない。
if [ -z "$branch" ] && [ -n "$git_common" ] && [ "$git_rc" -ne 0 ]; then
  branch=$(git -C "$cwd" branch --show-current 2>/dev/null)
fi
[ -z "$branch" ] && branch="$wt_branch"
repo="${repo_name:-$(basename "${project_dir:-$cwd}")}"

# 3行目: コンテキストバー＋% ・ モデル[エフォート]
[[ "$ctx_pct" =~ ^[0-9]+$ ]] || ctx_pct=0
cells=10; filled=$(( (ctx_pct + 5) / 10 )); (( filled > cells )) && filled=$cells
bar=""; for ((i=0;i<cells;i++)); do (( i < filled )) && bar+="█" || bar+="░"; done
effort_str=""; [ -n "$effort" ] && effort_str=" ${DIM}[${effort}]${RST}"

# 4行目: レート制限（epoch も ISO も許容、欠落時は出さない）
fmt() { local v="$1" f="$2"; [ -z "$v" ] && return
  if [[ "$v" =~ ^[0-9]+$ ]]; then date -d "@$v" +"$f" 2>/dev/null
  else date -d "$v" +"$f" 2>/dev/null; fi; }

now=$(date +%s)

# 窓ラベルと時刻書式は**窓長(分)から導出する**。5h / 7d をハードコードしない
# — プラン変更で窓が増減しても追従できるようにするため。
#   1440 の倍数 → Nd + 日付時刻 / 60 の倍数 → Nh + 時刻 / それ以外 → Nm + 時刻
winlabel() { local m="$1"
  if   [ $(( m % 1440 )) -eq 0 ]; then printf '%dd' $(( m / 1440 ))
  elif [ $(( m % 60 ))   -eq 0 ]; then printf '%dh' $(( m / 60 ))
  else                                 printf '%dm' "$m"; fi; }
winfmt() { local m="$1"
  if [ $(( m % 1440 )) -eq 0 ]; then printf '%s' '%-m/%-d %-l%P'
  else                               printf '%s' '%-l%P'; fi; }

# 経過時間の日本語表記（鮮度降格時に値へ併記する）。
elapsed_ja() { local s="$1"
  if   [ "$s" -lt 3600 ];  then printf '%d分前'   $(( s / 60 ))
  elif [ "$s" -lt 86400 ]; then printf '%d時間前' $(( s / 3600 ))
  else                          printf '%d日前'   $(( s / 86400 )); fi; }

# レート制限セグメント: used% の隣に「現時点の適正ペース＝目安%」を表示する。
# 目安% = 経過割合×100（リセットまで線形に使い切る場合の、今あるべき到達%）。
# used% を目安と比較して着色: 目安超過=赤(速い) / 目安未満=緑(余裕) / ほぼ同等=白。
# 経過割合 frac = (窓長 - (リセット - now)) / 窓長。引数: used reset 窓長秒 [降格]
#
# 第 4 引数が非空なら**ペース着色をやめて淡色へ降格する**（値が古いとき）。
# 降格するのは値だけで、提供元ラベルの色は呼び出し側で保つ
# — ラベルまで淡色化すると提供元の境目の手がかりが消える。
rlseg() {
  local used="$1" reset="$2" dur="$3" faded="${4:-}"
  [[ "$used" =~ ^[0-9.]+$ && "$reset" =~ ^[0-9]+$ ]] \
    || { [ -n "$faded" ] && printf '%s' "${DIM}${used}%${RST}" || printf '%s' "${BOLD}${used}%${RST}"; return; }
  awk -v u="$used" -v reset="$reset" -v dur="$dur" -v now="$now" -v faded="$faded" \
      -v red="$RED" -v grn=$'\033[1;32m' -v wht=$'\033[1m' \
      -v dim=$'\033[2;37m' -v rst=$'\033[0m' 'BEGIN{
    frac=(dur-(reset-now))/dur; if(frac<0)frac=0; if(frac>1)frac=1;
    tgt=frac*100; t=int(tgt+0.5);
    if(faded!="") c=dim;
    else if(frac<0.05) c=wht; else if(u>tgt*1.15) c=red; else if(u<tgt*0.85) c=grn; else c=wht;
    printf "%s%s%%%s %s目安%d%%%s", c, u, rst, dim, t, rst;
  }'
}

# レート制限ブロック 1 個: <窓ラベル> <使用%> 目安<N>% (リセット時刻)
# 引数: used% リセット(epoch|ISO) 窓長分 [降格]
rlblock() {
  local used="$1" reset="$2" mins="$3" faded="${4:-}"
  printf '%s%s %s%s %s(%s)%s' \
    "$DIM" "$(winlabel "$mins")" "$RST" \
    "$(rlseg "$used" "$reset" $(( mins * 60 )) "$faded")" \
    "$DIM" "$(fmt "$reset" "$(winfmt "$mins")")" "$RST"
}

# codex ブロック列。**キャッシュを読むだけ**で、ここから外部取得はしない。
# 状態と表示の対応:
#   値あり・新しい            → 通常表示（ペース着色あり）
#   値あり・直近の試行が失敗  → **通常表示のまま**（失敗は表示しない）
#   値あり・鮮度しきい値超過  → 淡色へ降格 + 経過時間を併記
#   値が無く取得もできない    → 「取得不可」
#   未認証                    → 赤で「未認証」+ 復旧コマンド
#   API 未対応                → 行から消す（壊れた表示を出し続けない）
codex_blocks() {
  local out="" first=1 w used mins reset age faded=""
  case "${SL_CX_STATUS:-}" in
    unsupported) return 0 ;;
    unauth) printf '%s未認証%s %s(codex login)%s' "$RED" "$RST" "$DIM" "$RST"; return 0 ;;
  esac
  # 鮮度は **ok_at（最後の成功）** で測る。fetched（最後の試行）で測ると、
  # 失敗が続いただけで直前まで正確だった値が降格する。
  age=$(( now - ${SL_CX_OK_AT:-0} ))
  [ "${SL_CX_OK_AT:-0}" -gt 0 ] && [ "$age" -ge "$AVCL_SL_STALE_AFTER" ] && faded=1
  for w in "${SL_CX_WINS[@]}"; do
    read -r used mins reset <<< "$w"
    # 窓長が取れない窓はラベルを導出できないので表示しない。
    [ "$mins" -gt 0 ] 2>/dev/null || continue
    [ "$first" = 1 ] || out+="  "     # 提供元内のブロック間はスペース 2 個
    first=0
    out+="$(rlblock "$used" "$reset" "$mins" "$faded")"
  done
  if [ -z "$out" ]; then
    [ "${SL_CX_STATUS:-}" = error ] && printf '%s取得不可%s' "$DIM" "$RST"
    return 0
  fi
  [ -n "$faded" ] && out+=" ${DIM}$(elapsed_ja "$age")${RST}"
  printf '%s' "$out"
}

# Claude 本体の窓長（分）。stdin JSON は窓長を持たずキー名だけで示すので、
# スキーマ由来の定数としてここに置く。**ラベルと書式はここから導出する。**
CLAUDE_WIN_5H=300
CLAUDE_WIN_7D=10080

# 出力
printf '%b\n' "${DIM}${dir}${RST}"
printf '%b\n' "${CYAN}${repo}${RST} ${SEP}/${RST} ${DIM}${branch}${RST}"
printf '%b\n' "${GREEN}${bar}${RST} ${BOLD}${ctx_pct}%${RST} ${SEP}|${RST} ${MODEL}${model}${RST}${effort_str}"
# rate_limits が無ければ 4 行目を出さない（現行の挙動を維持する）。
# codex 側だけで 4 行目を起こさないのは、ここが「Claude の枠を見る行」だから。
if [ -n "$rl5_pct" ] || [ -n "$rl7_pct" ]; then
  claude_blocks=""
  [ -n "$rl5_pct" ] && claude_blocks+="$(rlblock "$rl5_pct" "$rl5_reset" "$CLAUDE_WIN_5H")"
  if [ -n "$rl7_pct" ]; then
    [ -n "$claude_blocks" ] && claude_blocks+="  "   # 提供元内は 2 個
    claude_blocks+="$(rlblock "$rl7_pct" "$rl7_reset" "$CLAUDE_WIN_7D")"
  fi

  # codex — ヘルパが読めて CLI があるときだけ。CLI 不在はブロックごと出さない
  # （command -v は builtin なのでプロセスを作らず、毎レンダー再判定してよい）。
  codex_out=""
  if declare -F avcl_sl_cache_read >/dev/null 2>&1 && command -v codex >/dev/null 2>&1; then
    # **パス解決・読み取り・パース・更新判定はプロセスを 1 つも作らない。**
    # 結果はグローバルで受け取る（コマンド置換すら使わない）。
    if avcl_sl_set_cache_path "$git_common"; then
      avcl_sl_cache_read "$SL_CX_CACHE"
      # 取得は切り離した背景プロセスへ。描画はその完了を待たない。
      avcl_sl_should_refresh "$now" && avcl_sl_spawn_refresh "$SL_CX_CACHE"
      codex_out="$(codex_blocks)"
    fi
  fi

  line4=""
  [ -n "$claude_blocks" ] && line4="${MODEL}claude${RST} ${claude_blocks}"
  if [ -n "$codex_out" ]; then
    [ -n "$line4" ] && line4+="    "                 # 提供元間は 4 個
    line4+="${CYAN}codex${RST} ${codex_out}"
  fi
  printf '%b\n' "$line4"
fi
