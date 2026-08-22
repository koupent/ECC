# Agent Orkestrasyonu

## Mevcut Agent'lar

`~/.claude/agents/` dizininde bulunur:

| Agent | Amaç | Ne Zaman Kullanılır |
|-------|---------|-------------|
| planner | Uygulama planlaması | Karmaşık özellikler, refactoring |
| architect | Sistem tasarımı | Mimari kararlar |
| tdd-guide | Test odaklı geliştirme | Yeni özellikler, hata düzeltmeleri |
| code-reviewer | Kod incelemesi | Kod yazdıktan sonra |
| security-reviewer | Güvenlik analizi | Commit'lerden önce |
| build-error-resolver | Build hatalarını düzeltme | Build başarısız olduğunda |
| e2e-runner | E2E testleri | Kritik kullanıcı akışları |
| refactor-cleaner | Ölü kod temizliği | Kod bakımı |
| doc-updater | Dokümantasyon | Dokümanları güncelleme |
| rust-reviewer | Rust kod incelemesi | Rust projeleri |

## Agent Kullanım Politikası

Kanonik devretme politikası `rules/common/agents.md` dosyasıdır; bu belge onun çevirisidir.

**Kapsam.** Bu politika, bu paketteki diğer tüm kural belgelerinde geçen her "X agent'ını kullan"
adımını, ifadesi ne kadar kesin olursa olsun yönetir. Bu adımların her birini "bu politika izin
verdiğinde devret" biçiminde okuyun.

**Mekanizma.** Bu kural devretmenin ne zaman yararlı olduğunu anlatır; bir agent'ı otomatik olarak
başlatmaz ve hiçbir runtime kendiliğinden bir agent başlatmaz. Bir agent yalnızca ana model mevcut
Agent veya Task aracını çağırıp sonucunu topladığında çalışır.

**Beklenti.** Bu araç mevcutsa ve daha yüksek öncelikli talimatlar izin veriyorsa, devretip
devretmeyeceğine kendin karar ver. Kullanıcıdan ayrı bir istek gerekmez.

**Öncelik.** Sistem, runtime veya harness, organizasyon ve kullanıcı talimatları her zaman bu
kuralın önündedir. Harness devretmeyi kısıtlıyorsa — örneğin "kullanıcı istemedikçe Agent aracını
çağırma" — harness'a uy. Bu kural o durumda hangi bakış açılarının karşılanacağını söyler, kısıtı
geçersiz kılma izni vermez.

Devretme araçları mevcutsa ve daha yüksek öncelikli talimatlar kullanımlarına izin veriyorsa:
1. Karmaşık özellik istekleri - **planner** agent'ı değerlendir
2. Kod yeni yazıldı/değiştirildi - **code-reviewer** agent'ı değerlendir
3. Hata düzeltmesi veya yeni özellik - **tdd-guide** agent'ı değerlendir
4. Mimari karar - **architect** agent'ı değerlendir

Devretme mevcut değilse veya yasaksa, işi ana bağlamda tut ve aynı planlama, test ve inceleme
kontrol listelerini doğrudan uygula. Araç çağrısı yapılmadan ve sonuç toplanmadan bir agent'ın
çalıştığını asla iddia etme.

## Paralel Görev Yürütme

Paralel Task yürütmeyi yalnızca gerçekten bağımsız işlemler için, runtime devretmeye izin
verdiğinde ve ana model turunu bitirmeden önce tüm sonuçları toplayabildiğinde kullan. Sonucu
toplanmayan devretme yasaktır:

```markdown
# İYİ: Paralel yürütme
3 agent'ı paralel başlat:
1. Agent 1: Auth modülü güvenlik analizi
2. Agent 2: Cache sistemi performans incelemesi
3. Agent 3: Utilities tip kontrolü

# KÖTÜ: Gereksiz sıralı yürütme
Önce agent 1, sonra agent 2, sonra agent 3
```

## Çok Perspektifli Analiz

Karmaşık problemler için, devretmeye izin verildiğinde ve bakış açıları gerçekten bağımsız
olduğunda split role sub-agent'ları değerlendir:
- Factual reviewer
- Senior engineer
- Security expert
- Consistency reviewer
- Redundancy checker

Devretme mevcut değilse, aynı bakış açılarını ana bağlamda ayrı geçişler olarak yürüt. Yalnızca
diff'e bakan bir incelemenin kaçırdığı kusurları — örneğin diff'i tek satıra dokunan bir yordamın
adım sırasının yanlış olması — yakalayan şey bakış açısıdır; agent yalnızca araçtır.
