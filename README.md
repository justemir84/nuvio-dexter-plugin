# Nuvio Plugin Repository

> 💬 **İletişim / Sorun / Öneri:** [t.me/justemir84dev](https://t.me/justemir84dev)
> Çalışmayan kaynak, yanlış eşleşme veya yeni site önerisi için buradan benimle iletişime geçebilirsiniz.

Bu depo, Nuvio uygulamasının **Plugins** bölümüne eklenen bir sağlayıcı (provider) deposudur; Stremio/Nuvio **Addons** manifesti değildir.

## Kurulum

1. Nuvio’da **Settings → Content & Discovery → Plugins → Add Repository** bölümünü açın.
2. Şu manifest adresini ekleyin: [https://raw.githubusercontent.com/justemir84/nuvio-dexter-plugin/main/manifest.json](https://raw.githubusercontent.com/justemir84/nuvio-dexter-plugin/main/manifest.json)
3. Sağlayıcılar listesinden kullanmak istediklerinizi etkinleştirin.

## Sağlayıcılar

| Sağlayıcı | İçerik türü | Biçim | Not |
|---|---|---|---|
| Dexter.pw | Film + Dizi | HLS | Bölüm bazında kaynak; Türkçe altyazı destekli |
| KMMovies | Film + Dizi | MKV / MP4 | Hintçe ve İngilizce içerik; dizilerde bölüm bazında doğrudan dosyalar |
| YTS | Film | Torrent | YTS film kaynakları |
| VidCloud | Film + Dizi | HLS | İngilizce altyazı destekli |
| Mapple | Film + Dizi | HLS | Çok sunuculu; ilk açılışta PoW çözümü birkaç saniye sürebilir |
| Atlantic | Film + Dizi | HLS | 4K varyantlar ve İngilizce altyazı |
| VAplayer | Film + Dizi | HLS | İngilizce içerik |
| MoviesAPI | Film + Dizi | HLS | VidSpark altyapısı; çok dilli VTT altyazı |
| PopWatch | Film + Dizi | HLS | Birden çok kaynaklı scraper ağı; çok dilli altyazı |
| Vidlove | Film + Dizi | HLS | moviebox2/vidapi kaynak ağı; 4K’ya kadar, çok dilli VTT altyazı |
| VidRift | Film + Dizi | HLS | Orion altyapısı; HEVC ve çok dilli ses seçenekleri |
| VidBolt | Film + Dizi | HLS | 1080p’ye kadar; çok dilli ses ve altyazı seçenekleri |
| ThugTV | Film + Dizi | HLS / MP4 | Castle, Bishop ve Knight sunucuları; çok dilli altyazı |
| 123Movies | Film + Dizi | MP4 | aoneroom altyapısı; SRT altyazı |
| VixSrc | Film + Dizi | HLS | İtalyanca/İngilizce çift ses; çok dilli VTT altyazı |
| VidRock | Film + Dizi | HLS | Luna/Orion dahil birden fazla sunucu; 1080p’ye kadar |
| 4KHDHub | Film + Dizi | HLS / MP4 | 4K/UHD film ve dizi kaynakları |
| 4KHD Club | Film + Dizi | MKV | 4K REMUX arşivi; MKV indirme bağlantıları |
| MoviesDrive | Film + Dizi | MKV / MP4 | HubCloud üzerinden R2 doğrudan bağlantıları; Hintçe ve İngilizce |
| UHDMovies | Film + Dizi | MP4 / MKV | TMDB başlığı/yılı ile arama; Google Drive bağlantıları, 2160p’ye kadar. İsteğe bağlı kişisel TMDB anahtarı provider ayarlarından girilebilir. |
| Febbox | Film + Dizi | MP4 / MKV | Febbox / SuperStream kaynakları; token gerekir |

| FrameX TV | Film + Dizi | MP4 / HLS | Çoklu provider; çok dilli VTT altyazı |

## Kaynak listesi ve oynatma

- Sağlayıcıların bulduğu kaynaklar Nuvio’nun oynatıcı uyumluluğuna göre değişebilir; bazı sitelerdeki gömülü web oynatıcıları doğrudan video akışı değildir.
- Kalite, codec, HDR, ses dili ve dosya boyutu gibi bilgiler kaynak tarafından sağlanıyorsa gösterilir.

## Liste düzeni

- Sonuçlar çözünürlüğe göre yukarıdan aşağı sıralanır: **4K → 1080p → Auto → 720p → altı**.
- HD sonuç yoksa alt kaliteler gösterilir, liste boş kalmaz.
- Başlık satırlarında kalite, codec (HEVC/H.264), HDR/DV, ses (Atmos/DDP 5.1), dil ve boyut bilgisi yazar — kaynakta varsa.

## Sorun giderme

- **Kaynak listesi boş:** Repo adresinin yukarıdaki manifest adresi olduğunu ve ilgili sağlayıcının Nuvio ayarlarında etkin olduğunu kontrol edin; ardından sağlayıcı deposunu yenileyin.
- **Oynatma takılıyorsa:** Başka bir kaynak veya kalite seçeneğini deneyin; bazı bağlantılar kısa süreli olabilir.
- **Hata sürüyorsa:** Telegram’dan film/dizi adı, sezon-bölüm ve sağlayıcı adıyla bildirin.

## Yasal uyarı

Bu proje eğitim amaçlıdır. Depo içerik barındırmaz; yalnızca kaynak bağlantılarını listeler. Kullanımınızın bulunduğunuz yerin yasalarına uygun olmasından siz sorumlusunuz.
