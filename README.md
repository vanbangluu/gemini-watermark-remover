# Gemini Watermark Remover — Server

HTTP API server for removing Gemini watermarks from AI-generated images and videos. Wraps the [`@pilio/gemini-watermark-remover`](https://www.npmjs.com/package/@pilio/gemini-watermark-remover) SDK to expose watermark removal as a web service with drag-and-drop UI.

---

## Thuật toán & kỹ thuật

### Gemini áp watermark như thế nào

Gemini áp watermark bằng kỹ thuật **Alpha Compositing** — đây là phép toán chuẩn để blending hai ảnh dựa trên kênh alpha:

$$watermarked = \alpha \cdot logo + (1 - \alpha) \cdot original$$

Trong đó:
- `watermarked`: giá trị pixel đã bị đóng watermark
- `α` (alpha): độ trong suốt của logo (0.0 - 1.0)
- `logo`: giá trị màu của logo watermark (trắng = 255)
- `original`: giá trị pixel gốc chưa bị watermark

Quá trình này trộn logo với ảnh gốc theo tỉ lệ alpha. Logo có màu trắng sáng, nằm ở góc dưới bên phải, với độ trong suốt được kiểm soát bởi kênh alpha.

### Reverse Alpha Blending — giải pháp toán học chính xác

Thay vì dùng AI inpainting (vốn "đoán" pixel bị che và có thể sai), engine này **giải ngược phương trình Alpha Blending** để khôi phục chính xác pixel gốc:

$$original = \frac{watermarked - \alpha \cdot logo}{1 - \alpha}$$

Điều kiện để công thức này hoạt động:
1. **Phải biết alpha map** — bản đồ độ trong suốt của chính xác watermark
2. **Phải biết màu logo** — Gemini dùng logo trắng (255, 255, 255)
3. **α ≠ 1** — không chia cho 0; pixel có α=1 là logo thuần, không thể khôi phục

### Pipeline xử lý

```
BƯỚC 1: DETECT
├── Size catalog lookup — so khớp kích thước ảnh với catalog output đã biết của Gemini
│   ├── Ảnh lớn: watermark 96×96, margin phải 64px, margin dưới 64px
│   └── Ảnh nhỏ: watermark 48×48, margin phải 32px, margin dưới 32px
├── Local anchor search — quét vùng pixel xung quanh vị trí dự đoán để xác định chính xác
└── Restoration validation — xác nhận watermark là thật trước khi áp dụng removal

BƯỚC 2: EXTRACT ALPHA MAP
├── Dùng calibrated watermark masks đã biết (từ các mẫu đã phân tích của Gemini)
├── Alpha map được reconstruct từ việc chụp watermark trên background rắn
└── Áp dụng cho từng pixel RGBA trong vùng watermark

BƯỚC 3: REVERSE BLEND
├── Mỗi pixel: original = (watermarked - α * 255) / (1 - α)
├── Xử lý edge cases:
│   ├── α ≈ 0 → pixel gần như không bị ảnh hưởng → giữ nguyên
│   ├── α ≈ 1 → pixel là logo thuần → không thể khôi phục (lossy)
│   └── 0 < α < 1 → áp dụng công thức reverse
└── Kết quả: ảnh sạch watermark, gần như lossless

BƯỚC 4: VALIDATE OUTPUT
├── So sánh residual giữa vùng đã xử lý và vùng xung quanh
├── Decision tiers:
│   ├── perfect — xóa watermark hoàn hảo
│   ├── good — residual rất thấp
│   ├── acceptable — residual thấp nhưng chấp nhận được
│   └── poor — residual đáng kể
└── Metadata trả về kèm theo kết quả
```

### Tại sao phương pháp này tốt hơn AI inpainting

| Tiêu chí | Reverse Alpha Blending | AI Inpainting |
|---|---|---|
| **Độ chính xác** | Toán học chính xác, không "đoán" | Có thể hallucinate, tạo artifact |
| **Lossless** | Gần như lossless (α < 1) | Luôn lossy |
| **Tốc độ** | O(n) với n pixel, vài ms | Hàng giây đến hàng phút |
| **Reproducible** | 100% reproducible | Non-deterministic |
| **Tài nguyên** | CPU đơn giản, không cần GPU | Cần GPU/TPU |
| **Giới hạn** | Chỉ hoạt động với watermark đã biết pattern | Xóa được watermark tổng quát |

### Giới hạn

- Chỉ xóa **visible watermark** của Gemini (logo bán trong suốt góc dưới phải)
- Không xóa **invisible/steganographic watermark** (SynthID)
- Yêu cầu watermark pattern phải khớp với catalog đã calibrate
- Pixel có α = 1 (logo thuần) không thể khôi phục hoàn hảo — nhưng những pixel này rất ít

---

## API Documentation

Base URL: `http://127.0.0.1:9010`

### GET /

Web UI cho phép kéo-thả file để xóa watermark trực quan.

**Response:** HTML page with drag-and-drop interface, before/after preview, and download button.

---

### GET /health

Kiểm tra trạng thái server.

**Response** `200 OK`
```json
{
  "status": "ok"
}
```

---

### POST /remove

Xóa watermark khỏi ảnh hoặc video. Chấp nhận multipart/form-data upload.

**Request**

| Field | Type | Required | Description |
|---|---|---|---|
| `file` | file | yes | Ảnh hoặc video cần xóa watermark |

**Supported formats:**
- **Images:** PNG, JPEG, WebP
- **Videos:** MP4, WebM, MOV, AVI, MKV

**Response** `200 OK` — file đã xử lý (binary stream)

**Response headers:**

| Header | Value | Description |
|---|---|---|
| `Content-Type` | image/png, image/jpeg, video/mp4, ... | MIME type của file kết quả |
| `Content-Disposition` | `attachment; filename="clean_<original-name>"` | Tên file download |
| `X-Watermark-Removed` | `true` hoặc `false` | Có xóa được watermark không |
| `X-Decision-Tier` | `perfect`, `good`, `acceptable`, `poor`, `unknown` | Chất lượng xóa watermark |

**Error responses:**

`400 Bad Request` — request không hợp lệ
```json
{
  "error": "Expected multipart/form-data"
}
```

```json
{
  "error": "No file uploaded"
}
```

`500 Internal Server Error` — lỗi xử lý
```json
{
  "error": "<error message>"
}
```

**Ví dụ:**

Sử dụng curl:
```bash
# Image
curl -X POST http://127.0.0.1:9010/remove \
  -F "file=@watermarked.png" \
  -o clean.png

# Video
curl -X POST http://127.0.0.1:9010/remove \
  -F "file=@watermarked.mp4" \
  -o clean.mp4
```

Sử dụng JavaScript:
```javascript
const formData = new FormData();
formData.append('file', fileInput.files[0]);

const response = await fetch('http://127.0.0.1:9010/remove', {
  method: 'POST',
  body: formData,
});

const blob = await response.blob();
console.log('Removed:', response.headers.get('X-Watermark-Removed'));
console.log('Tier:', response.headers.get('X-Decision-Tier'));

// Download
const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url;
a.download = 'clean_image.png';
a.click();
```

Sử dụng Python:
```python
import requests

with open('watermarked.png', 'rb') as f:
    response = requests.post(
        'http://127.0.0.1:9010/remove',
        files={'file': f}
    )

with open('clean.png', 'wb') as out:
    out.write(response.content)

print('Removed:', response.headers.get('X-Watermark-Removed'))
print('Tier:', response.headers.get('X-Decision-Tier'))
```

---

## Decision Tiers

Server trả về header `X-Decision-Tier` cho biết chất lượng xóa watermark:

| Tier | Ý nghĩa |
|---|---|
| `validated-match` | Watermark được phát hiện và xác nhận; xóa thành công |
| `direct-match` | Khớp trực tiếp với catalog watermark đã calibrate |
| `insufficient` | Không đủ bằng chứng watermark — không phát hiện watermark |
| `runtime-failure` | Lỗi xử lý runtime |

Ngoài ra `X-Watermark-Removed` là `true`/`false` cho biết watermark có thực sự bị xóa hay không.

---

## Edge Cases & Xử lý lỗi

| Tình huống | Response |
|---|---|
| File không có watermark Gemini | `X-Watermark-Removed: false`, trả về file gốc |
| File format không hỗ trợ | Có thể trả về lỗi decode từ `sharp` |
| Watermark không khớp catalog | `X-Decision-Tier: unknown`, vẫn cố gắng xử lý |
| File quá lớn (>100MB) | Server cần đủ RAM để buffer toàn bộ file |
| Video có watermark không chuẩn | `X-Watermark-Removed: false` |

---

## CLI Tool

Ngoài API HTTP, project đi kèm CLI wrapper tại `tools/gemini-watermark-remover/gwr.sh`:

```bash
# Sử dụng cơ bản
./gwr.sh remove input.png --output clean.png

# JSON output
./gwr.sh remove input.png --output clean.png --json

# Tự động đặt tên output (clean_<original>)
./gwr.sh remove input.png
```

CLI wrapper gọi server API — đảm bảo server đang chạy trước khi dùng CLI.

---

## Kiến trúc

```
┌─────────────────────────────────────────────┐
│  Web UI (public/index.html)                 │
│  Drag-drop → FormData → POST /remove        │
└──────────────┬──────────────────────────────┘
               │
┌──────────────▼──────────────────────────────┐
│  HTTP Server (server.mjs)                   │
│  ├── GET  /health     → Health check        │
│  ├── GET  /           → Web UI              │
│  └── POST /remove     → Multipart handler   │
│       ├── Parse multipart boundary           │
│       ├── Save to temp dir                   │
│       ├── Detect image/video                 │
│       └── Call SDK                           │
└──────────────┬──────────────────────────────┘
               │
┌──────────────▼──────────────────────────────┐
│  @pilio/gemini-watermark-remover SDK        │
│  ├── removeWatermarkFromFile()  (image)     │
│  │   └── Reverse Alpha Blending pipeline    │
│  └── removeVideoWatermarkFromFile() (video) │
│      └── Frame-by-frame processing          │
└──────────────┬──────────────────────────────┘
               │
┌──────────────▼──────────────────────────────┐
│  sharp (image codec)                        │
│  decodeImageData ← buffer → raw RGBA        │
│  encodeImageData ← raw RGBA → buffer        │
└─────────────────────────────────────────────┘
```

---

## Cài đặt & Chạy

### Yêu cầu

- Node.js >= 18
- npm

### Development

```bash
git clone git@github.com:vanbangluu/gemini-watermark-remover.git
cd gemini-watermark-remover
npm install
PORT=9010 node server.mjs
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `9010` | Server port |
| `HOST` | `127.0.0.1` | Bind address |

### Compass-managed (SGIP)

```bash
# Install
curl -X POST http://127.0.0.1:9800/services/gemini-watermark-remover/install

# Start
curl -X POST http://127.0.0.1:9800/services/gemini-watermark-remover/start

# Health check
curl http://127.0.0.1:9010/health
```

---

## License

MIT — xem [LICENSE](LICENSE) của upstream project.
