GPP DATA ENTRY LITE V1.2.1 – BẢN VÁ ỔN ĐỊNH OCR TRÊN NỀN V1.2

Mục tiêu: giữ nguyên cấu trúc/giao diện/cách chạy HTML của V1.2, chỉ sửa đúng các điểm yếu OCR đã xác định.

THAY ĐỔI V1.2.1
1. OCR không còn dùng biến activeImage. activeImage chỉ dùng để xem/zoom ảnh.
2. Mỗi lần upload tạo OCR job riêng gồm job.id, documentType, revision và image đã khóa.
3. OCR chạy tuần tự bằng hàng đợi, không chạy nhiều Tesseract worker song song.
4. Nếu ảnh bị thay/xóa hoặc hồ sơ đổi trong lúc OCR, kết quả job cũ tự bị hủy, không ghi đè.
5. Bằng tốt nghiệp: năm cấp chỉ nhận ngữ cảnh tiếng Việt “ngày ... năm 19xx/20xx”; không lấy một năm rời rạc hoặc dòng tiếng Anh.
6. Năm cấp bằng có OCR ROI riêng ở nửa dưới, thiên phải.
7. Trường tốt nghiệp chỉ lấy phần tiếng Việt bắt đầu từ TRƯỜNG và phải có ĐẠI HỌC/CAO ĐẲNG/TRUNG CẤP/HỌC VIỆN. Loại phần tiếng Anh phía trước.
8. Chuẩn hóa an toàn hai mẫu đã biết: TRƯỜNG CAO ĐẲNG Y TẾ TIỀN GIANG, TRƯỜNG ĐẠI HỌC TÂY ĐÔ; không tự đoán tên riêng khác.
9. CCHND có OCR ROI hỗ trợ vùng đầu giấy để tìm UBND/SỞ Y TẾ + tỉnh.
10. GPKD có OCR ROI hỗ trợ vùng “Trụ sở...” để tăng độ ổn định của địa chỉ.
11. Confidence OCR tự động tối đa 96%; không còn 99% chỉ do OCR/rule. Người dùng sửa/nhập trực tiếp vẫn là 100%.
12. Giữ nguyên IndexedDB GPPDataEntryLiteV1 để tiếp tục dùng hồ sơ cũ.

CÁCH CHẠY
- Cách nhanh: mở trực tiếp index.html.
- Khuyến nghị khi máy cho phép: START_GPP_V1.bat -> http://localhost:8787.
- Lần đầu OCR cần Internet để tải/cache Tesseract.js và model tiếng Việt từ CDN.

LƯU Ý
- V1.2.1 không thay OCR engine, không đổi giao diện lớn, không thay database.
- Không chắc thì để trống; người dùng có thể sửa/nhập trực tiếp mọi ô.
