# Dexter.pw — Nuvio Plugin Repository

Bu depo, Nuvio uygulamasının **Plugins** bölümünde eklenen bir provider deposudur; Stremio/Nuvio **Addons** manifesti değildir.

## Kurulum

Nuvio'da **Settings → Content & Discovery → Plugins → Add Repository** yolundan şu manifest adresini ekleyin:

`https://raw.githubusercontent.com/justemir84/nuvio-dexter-plugin/main/manifest.json`

## Depo yapısı

- `manifest.json`: Güncel Nuvio plugin şemasında üst düzey `name`, `version` ve `scrapers` alanlarını içerir.
- `providers/dexterpw.js`: Manifestteki `filename` alanıyla eşleşen derlenmiş provider modülüdür.

Manifestteki dosya yolu, manifest adresinin bulunduğu klasöre göre çözülür. Provider modülü `getStreams` fonksiyonunu dışa aktarır. Manifest ve dosya yolu doğrulanmıştır; gerçek video oynatma henüz Nuvio içinde doğrulanmış değildir.
