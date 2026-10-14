# Dexter.pw — Nuvio Plugin Repository

Bu depo, Nuvio uygulamasının **Plugins** bölümünde eklenen bir provider deposudur; Stremio/Nuvio **Addons** manifesti değildir.

## Kurulum

Nuvio'da **Settings → Content & Discovery → Plugins → Add Repository** yolundan şu manifest adresini ekleyin:

`https://raw.githubusercontent.com/justemir84/nuvio-dexter-plugin/main/manifest.json`

## Depo yapısı

- `manifest.json`: Güncel Nuvio plugin şemasında üst düzey `name`, `version` ve `scrapers` alanlarını içerir.
- `providers/dexterpw.js`: Manifestteki `filename` alanıyla eşleşen derlenmiş provider modülüdür.

Manifestteki dosya yolu, manifest adresinin bulunduğu klasöre göre çözülür. Provider modülü `getStreams` fonksiyonunu dışa aktarır. Manifest ve dosya yolu doğrulanmıştır; gerçek video oynatma henüz Nuvio içinde doğrulanmış değildir.

## Oynatma ve kapsam

Provider, film için film API’sini; dizilerde ise sezon/bölüm bazında episode API’sini çağırır. Yalnızca `kind: hls` veya açık `.m3u8` doğrudan kaynakları Nuvio’ya verir ve her stream’de `type: hls` bildirir. `embed`/`player` kaynakları HTML sayfası olduğundan native video stream gibi sunulmaz. Dexter.pw’ın her katalog öğesinde doğrudan oynatılabilir HLS sunması garanti edilemez.
### IDLIX için cf_clearance Cookie'si Nasıl Alınır ve Girilir?

IDLIX sitesi Cloudflare korumalı olduğu için, eklentinin çalışabilmesi adına tarayıcınızdan alacağınız `cf_clearance` çerezini Nuvio'daki IDLIX ayarlarına girmeniz gerekir.

**Adım Adım:**

1. Tarayıcınızda `https://z2.idlixku.com` adresini açın.
2. `F12` tuşuyla Geliştirici Araçları'nı açın.
3. Üstteki sekmelerden **Application** (Uygulama) sekmesine geçin.
4. Sol menüden **Cookies** → `https://z2.idlixku.com` yolunu seçin.
5. Listede **`cf_clearance`** adlı cookie'yi bulun. **Value** (Değer) sütunundaki uzun metni tamamen kopyalayın.
6. Nuvio'da:
   - **Ayarlar → Content & Discovery → Plugins** bölümüne gidin.
   - **IDLIX** sağlayıcısını bulun.
   - Yanındaki **⚙️ (Ayarlar)** butonuna tıklayın.
   - **Cloudflare cf_clearance Cookie** alanına kopyaladığınız değeri yapıştırın.
   - Kaydedin.

**Önemli:**
- Bu cookie tarayıcınıza ve IP adresinize özeldir. Her kullanıcı kendi cookie'sini almalıdır.
- Cookie'nin ömrü birkaç saat olabilir. Eklenti çalışmayı bırakırsa, yeni bir cookie alıp güncelleyin.
- TV box'ınızın IP'si ile cookie'yi aldığınız cihazın IP'si **aynı olmalıdır**. Eğer farklıysa cookie çalışmaz.
