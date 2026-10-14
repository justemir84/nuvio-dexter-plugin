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
### IDLIX Eklentisi için cf_clearance Cookie'si Nasıl Alınır ve Girilir?

IDLIX sitesi, Cloudflare tarafından korunmaktadır. Eklentinin çalışabilmesi için, tarayıcınızdan alacağınız `cf_clearance` adlı çerezi Nuvio'daki eklenti ayarlarına girmeniz gerekmektedir.

**Adım Adım Cookie Alma ve Girme:**

1.  **Tarayıcınızda IDLIX sitesine gidin:** `https://z2.idlixku.com` adresini açın.
2.  **Geliştirici Araçlarını açın:** `F12` tuşuna basın veya sağ tıklayıp "İncele" (Inspect) seçeneğini seçin.
3.  **"Application" (Uygulama) sekmesine gidin:** Açılan pencerede üstteki sekmelerden "Application" (bazı tarayıcılarda "Uygulama" veya "Depolama") sekmesini bulun.
4.  **Cookie'leri bulun:** Sol taraftaki menüden "Cookies" (Çerezler) altındaki `https://z2.idlixku.com` adresini seçin.
5.  **`cf_clearance` cookie'sini kopyalayın:** Sağ taraftaki listede `cf_clearance` adlı cookie'yi bulun. "Value" (Değer) sütunundaki uzun metni tamamen kopyalayın.
6.  **Nuvio'da ayarı girin:**
    *   Nuvio'da **Ayarlar** > **Yerel Scraper'lar** (Local Scrapers) bölümüne gidin.
    *   **IDLIX** eklentisini bulun ve yanındaki **Ayarlar** (Settings) butonuna tıklayın.
    *   Açılan pencerede **"IDLIX cf_clearance Cookie"** alanına, kopyaladığınız uzun metni yapıştırın.
    *   Kaydedin.

**Önemli Notlar:**
*   Bu çerez genellikle birkaç saat geçerlidir. Eklenti çalışmayı bırakırsa, aynı adımları tekrarlayarak yeni bir çerez alıp güncellemeniz gerekebilir.
*   Çerez, tarayıcınıza ve IP adresinize özeldir. Bu nedenle, her kullanıcının kendi çerezini alıp Nuvio'suna girmesi gerekir.
