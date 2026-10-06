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
