# MakeReady — gerçek üretim kanıtı

12 Ekim 2026, İstanbul. Fal faturalama kaydı yenileme: 13:26; kalıcı LLM kayıtlarını okuma: 13:27; Meshy ölçüm ve kredi doğrulaması: 13:40. CNC çalışması, yüklenen logo, logo revizyonu ve ayrı Meshy denemesi gerçek sağlayıcı çıktısından GLB, STL ve üretim paketi üretti. Aşağıdaki dosyalar yerel `artifacts/live/` klasöründedir ve Git'e dahil edilmez.

## Bağımsız ölçüm

Ölçü sırası **genişlik × derinlik × yükseklik**, birim **mm**. Kontrol GLB'yi dünya dönüşümleriyle yeniden yükler; STL'yi ayrı okuyucu ile açar. Tolerans 0,1 mm.

| Çalışma | İstenen ölçü | GLB'den ölçülen | Sonuç |
| --- | --- | --- | --- |
| CNC adayı | 100 × 100 × 12 | 116,716280 × 116,714347 × 12 | **Başarısız:** genişlik ve derinlik hedefi aşılmış; yükseklik doğru. |
| Yüklenen logo | Yalnızca 120 mm yükseklik | 177,717380 × 1,896771 × 120 | **Geçti:** istenen yükseklik doğru. Genişlik/derinlik hedefi verilmedi. |
| Revize logo | 25 mm derinlik, 120 mm yükseklik | 177,467747 × 69,627250 × 120 | **Başarısız:** derinlik hedefi +44,627250 mm aşılmış; yükseklik doğru. |
| Yüklenen logo / Meshy 7.1 | Yalnızca 120 mm yükseklik | 174,088551 × 12,855648 × 120 | **Ölçü geçti; fiziksel denetim başarısız.** Genişlik/derinlik hedefi verilmedi. |

CNC adayında genişlik +16,716280 mm, derinlik +16,714347 mm sapıyor. Bu çıktı 100 × 100 mm ölçü şartını karşılamıyor. Logo derinliği yaklaşık **1,897 mm**; duvar kalınlığı, malzeme dayanımı ve üretim uygunluğu ayrıca doğrulanmalı.

Her iki çalışmada kaynak/GLB/STL SHA-256 değerleri denetimle eşleşiyor, GLB Y-up / STL Z-up dönüşümü tutarlı ve zemin koordinatı 0. CNC: **80.000** üçgen; logo: **79.868** üçgen. En büyük GLB/STL köşe farkı sırasıyla 0,000001907 ve 0,000003814 mm.

Uygulanan fiziksel denetimler her iki dosyada 10 geçti / 0 başarısız gösteriyor. CNC'deki bağımsız ölçü hatası yukarıdaki tabloda korunuyor. Duvar kalınlığı, self-intersection, malzeme uygunluğu, CNC takım erişimi, bağlama ve takım yolu doğrulanmadı. Üretim durumu `preparation_only`; gerçek işleme veya baskı kanıtı yok.

- CNC: [ölçüm](../artifacts/live/cnc-20261012-1255/measurement.json), [denetim](../artifacts/live/cnc-20261012-1255/audit.json), [STL](../artifacts/live/cnc-20261012-1255/model.stl), [üretim paketi](../artifacts/live/cnc-20261012-1255/make-package.zip).
- Logo: [ölçüm](../artifacts/live/logo-20261012-1256/measurement.json), [denetim](../artifacts/live/logo-20261012-1256/audit.json), [STL](../artifacts/live/logo-20261012-1256/model.stl), [üretim paketi](../artifacts/live/logo-20261012-1256/make-package.zip).

### Meshy 7.1 — ayrı ve gerçek üretim

Aynı yüklenen logo konsepti için kullanıcı tarafından istenen ikinci sağlayıcı denendi. Model sabit `meshy-7.1`; otomatik fallback veya yeniden ücretli gönderim yapılmadı. İş `bb37b535-2b9d-4b5d-826e-eb8e3ed8a1ca`, sağlayıcı task ID `01a12faf-51ff-701d-9f01-fbcffff10585`, tamamlanmış revision `0dd6dc25-5900-4cda-9e65-871c6e61fd80`.

Gerçek dosya **82.211 üçgen** içeriyor. Bağımsız yükseklik, dosya hash'i, zemin ve GLB/STL koordinat kontrolleri geçti; en büyük köşe farkı **0,000003815 mm**. Fiziksel denetim **7 geçti / 3 başarısız**: 10 açık sınır kenarı, 5 manifold olmayan kenar ve 10 manifold olmayan vertex. Okunabilir kusurlu model ayrı revision olarak saklandı; rapor başarısız bulguları koruyor. Üretim durumu `preparation_only`.

Sağlayıcının task okuma yanıtı **30 kredi** tüketildiğini bildiriyor. Bunun USD karşılığı doğrulanmadı; kredi sayısı dolar olarak gösterilmiyor.

- [Bağımsız ölçüm](../artifacts/live/logo-meshy-20261012-1335/measurement.json), [fiziksel denetim](../artifacts/live/logo-meshy-20261012-1335/audit.json), [sağlayıcı kredi kaydı](../artifacts/live/logo-meshy-20261012-1335/billing.json).
- [Textured GLB](../artifacts/live/logo-meshy-20261012-1335/normalized.glb), [STL](../artifacts/live/logo-meshy-20261012-1335/model.stl), [üretim paketi](../artifacts/live/logo-meshy-20261012-1335/make-package.zip).
- [Canlı logo oturumu](https://makeready-preview-mmf-code.vercel.app/runs/d4feaec1-6e9b-4e7a-9665-46d40f2c3df6) aynı konseptten gelen Fal ve Meshy sürümlerini içeriyor.

### Gerçek revizyon zinciri

Logo geri bildirimi yeni konsept ve ayrı bir 3D sürüm üretti; eski sürüm korundu. Kalıcı eski/yeni 3D karşılaştırması derinlikte **+67,730479 mm**, genişlikte **−0,249633 mm**, yükseklikte **0 mm** ve üçgen sayısında **+132** fark kaydediyor. Bu karşılaştırma, doğrudan konsept → 3D karşılaştırmasından ayrı saklanıyor. Revizyon gerçekleşti; yaklaşık 25 mm derinlik isteği karşılanmadı.

- [Kalıcı karşılaştırmalar](../artifacts/live/logo-refined-20261012-1316/comparisons.json), [istenen derinliği de kontrol eden ölçüm](../artifacts/live/logo-refined-20261012-1316/measurement.json).
- [Aynı kamera ile gerçek model görselleri ve kontrol koşulları](AGENT_REFINEMENT_EVIDENCE.md).

## Gerçek USD maliyeti

Yeni üretim başlatılmadan, kayıtlı request ID'leri için fal `source=billed` faturalama kaynağı salt okunur sorgulandı. **Gerçek USD tutarları şu an doğrulanamadı.** Eksik tutarlar `null`; sıfır harcama kabul edilmedi.

| Çalışma / adım | Sağlayıcı request ID | Gerçek USD |
| --- | --- | --- |
| CNC / konsept | `01a12f87-5fa7-7de2-a68c-878cbbb25693` | Bilinmiyor — faturalama erişimi reddedildi. |
| CNC / 3D | `01a12f87-ef37-70a3-b203-d28750fe487f` | Bilinmiyor — faturalama erişimi reddedildi. |
| Logo / 3D | `01a12f8a-707f-7222-a794-e88b1af45a76` | Bilinmiyor — faturalama erişimi reddedildi. |
| Logo / konsept revizyonu | `01a12f9c-3c59-7341-9689-ffc97e95da8c` | Bilinmiyor — faturalama erişimi reddedildi. |
| Logo / revize 3D | `01a12f9d-053f-7c61-8ab0-d4f6a75029a8` | Bilinmiyor — faturalama erişimi reddedildi. |

Güvenli bağlantı kontrolü: `FAL_BILLING_KEY` dolu, üretim anahtarından farklı, boşluk veya yanlışlıkla eklenmiş `Key ` öneki yok. Faturalama uç noktası **HTTP 403 / `authorization_error`** döndü. Anahtarın gerçek izin paketi bu yanıttan belirlenemedi. Güncel resmi doküman bu uç nokta için `billing:usage:read`, `auth:keys:read`, `account:users:read` izinlerini ve bunları içeren **BILLING** paketini listeliyor. [fal Billing Events](https://fal.ai/docs/platform-apis/v1/models/billing-events), [anahtar izinleri](https://fal.ai/docs/documentation/model-apis/authentication/key-based#permissions).

- [CNC faturalama kaydı](../artifacts/live/cnc-20261012-1255/billing.json)
- [Logo faturalama kaydı](../artifacts/live/logo-20261012-1256/billing.json)
- [Altı logo oturum işini kapsayan güncel faturalama kaydı](../artifacts/live/logo-refined-20261012-1316/billing.json)
- [Anahtar değeri içermeyen erişim kontrolü](../artifacts/live/cnc-20261012-1255/billing-access.json)

### Anthropic

Mevcut Anthropic anahtarıyla resmi `/v1/organizations/cost_report` salt okunur sorgusu **HTTP 401 / `authentication_error`** döndü. Yerelde ayrı Admin anahtarı bulunmuyor. Güncel API; Admin anahtarı, `org:admin` OAuth yetkisi veya workspace ile sınırlandırılmamış yetkili kişisel/servis hesabı kimliği kabul ediyor. Maliyet raporu günlük organizasyon/workspace toplamları verir; tek request ID maliyetini doğrudan döndürmez. [Resmi Usage and Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api), [Cost Report parametreleri](https://platform.claude.com/docs/en/api/beta/organization/cost_report/retrieve).

CNC konsept işinin kaydedilmiş iki Anthropic çağrısında doğrulanan kullanım:

| Adım | Request ID | Girdi token | Çıktı token |
| --- | --- | --- | --- |
| Tasarım şartnamesi | `req_011Cfx8yLT15HFjev6PFpGnd` | 1.223 | 493 |
| Görsel eleştiri | `req_011Cfx91JtnYHvh9NKBtyoWS` | 3.023 | 1.005 |
| Bu iki kayıt toplamı | — | 4.246 | 1.498 |

Logo oturumundaki altı kalıcı iş salt okunur sorgulandı; üç LLM yanıt kaydı bulundu. Başarısız ilk planın sağlayıcı yanıtı da sayılıyor:

| Adım / iş sonucu | Request ID | Girdi token | Çıktı token |
| --- | --- | --- | --- |
| İlk plan / başarısız | `req_011Cfx9cZdXa261evc5jafqL` | 2.513 | 943 |
| Yeni plan / tamamlandı | `req_011CfxAgn5rvJeQGgjp2FJF8` | 2.582 | 778 |
| Revize konseptin görsel eleştirisi / tamamlandı | `req_011CfxAm44enPwaHo7iwNGKw` | 4.788 | 891 |
| Logo oturumundaki bu üç kayıt toplamı | — | 9.883 | 2.612 |

Beş kayıtlı CNC + logo çağrısı toplamı **14.129 girdi + 4.110 çıktı = 18.239 token**. Model `claude-haiku-5-5`; bu kayıtlarda cache tokenları 0. Token sayılarından fiyat varsayımıyla USD üretilmedi; tüm sağlayıcılardaki toplam gerçek harcama **bilinmiyor**. Bu kayıtlar dışında eksiksiz LLM faturalama kapsamı kanıtlanmadı; kullanım kaydı bulunmaması sıfır harcama anlamına gelmiyor.

- [Kaydedilmiş token kullanımı](../artifacts/live/cnc-20261012-1255/intelligence-usage.json)
- [Altı logo işinden ayıklanmış güvenli LLM kayıtları ve toplamları](../artifacts/live/logo-refined-20261012-1316/intelligence-usage.json)
- [Anahtar değeri içermeyen Anthropic maliyet erişimi sonucu](../artifacts/live/cnc-20261012-1255/anthropic-cost-access.json)
