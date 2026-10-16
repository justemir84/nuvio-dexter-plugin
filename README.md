# Nuvio Plugin Repository

> 💬 **İletişim / Sorun / Öneri:** [t.me/justemir84dev](https://t.me/justemir84dev)
> Çalışmayan kaynak, yanlış eşleşme veya yeni site önerisi için buradan benimle iletişime geçebilirsiniz.

Bu depo, Nuvio uygulamasının **Plugins** bölümüne eklenen bir sağlayıcı (provider) deposudur; Stremio/Nuvio **Addons** manifesti değildir.

## Kurulum

1. Nuvio'da **Settings → Content & Discovery → Plugins → Add Repository** yolunu açın.
2. Şu adresi ekleyin:
3. Listeden kullanmak istediklerinizi etkinleştirin.

## Sağlayıcılar

| Sağlayıcı | Tür | Biçim | Not |
|---|---|---|---|
| Dexter.pw | Film + Dizi | HLS | Bölüm bazında stream, Türkçe altyazı destekli |
| KMMovies | Film + Dizi | Direkt (mkv/mp4) | Hintçe-İngilizce; dizilerde sezon paketi döner |
| YTS | Film + Dizi | Torrent (magnet) | Doğrudan oynatır, debrid/token gerekmez |
| VidCloud | Film + Dizi | HLS | İngilizce altyazı destekli |
| Mapple | Film + Dizi | HLS | Çok sunuculu, ilk açılışta PoW çözümü birkaç saniye sürebilir |
| Atlantic | Film + Dizi | HLS | 4K varyantlar dahil, İngilizce altyazı destekli |
| Streamo | Film + Dizi | HLS | İngilizce içerik |
| VAplayer | Film + Dizi | HLS | İngilizce içerik |
| MoviesAPI | Film + Dizi | HLS | VidSpark altyapısı; 33+ dilde VTT altyazı |
| PopWatch | Film + Dizi | HLS | 7 kaynaklı scraper ağı (Laylah, Azalea vb.); çok dilli altyazı |
| Vidlove | Film + Dizi | HLS | moviebox2/vidapi kaynak ağı; 4K'ya kadar, çok dilli VTT altyazı |
| VidRift | Film + Dizi | HLS | Orion altyapısı; HEVC, çok dilli dublaj seçenekleri |
| VidBolt | Film + Dizi | HLS | 1080p'ye kadar; HLS içinde 10 dilde ses + 5 altyazı |
| ThugTV | Film + Dizi | HLS + MP4 | Castle/Bishop/Knight sunucuları; çok dilli altyazı |
| 123Movies | Film + Dizi | MP4 | aoneroom altyapısı; 1080p'ye kadar, SRT altyazı |

## Liste düzeni

- Sonuçlar çözünürlüğe göre yukarıdan aşağı sıralanır: **4K → 1080p → Auto → 720p → altı**.
- HD sonuç yoksa alt kaliteler gösterilir, liste boş kalmaz.
- Başlık satırlarında kalite, codec (HEVC/H.264), HDR/DV, ses (Atmos/DDP 5.1), dil ve boyut bilgisi yazar — kaynakta varsa.

## Sorun giderme

- **Liste boş:** Önce repo adresinin güncel olduğunu kontrol edin (yukarıdaki adres). Sağlayıcıyı kapatıp açın.
- **Buffering:** Başka bir varyant deneyin (özellikle `(Direct)` etiketliler). Dizi paketlerindeki bazı linkler kısa süreli olabilir(120sn), listeyi yenileyip hemen oynatın.
- **Hiçbiri çalışmıyorsa:** Telegram'dan (en üstteki adres) film/dizi adı + sağlayıcı ile bildirin.

## Yasal uyarı

Bu proje eğitim amaçlıdır. İçerik barındırmaz; herkese açık kaynaklardan bulunan oynatma adreslerini listeler. Kullanımınızın bulunduğunuz yerin yasalarına uygun olmasından siz sorumlusunuz.
