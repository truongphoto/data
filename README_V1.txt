GPP DATA ENTRY LITE V1.2 – BẢN CHÍNH THỨC

Mục tiêu: 5 loại giấy tờ dược -> 14 trường dữ liệu -> người dùng kiểm tra/sửa -> lưu -> xuất Excel.

NÂNG CẤP V1.2
1. Bằng tốt nghiệp: năm cấp ưu tiên khu vực phía dưới/góc phải, gần ngày ký – chữ ký – con dấu. Có OCR vùng mục tiêu lần 2.
2. Ảnh sau khi zoom có thể giữ chuột/kéo để di chuyển; nhấp đúp về vừa khung. Điện thoại có thể kéo bằng một ngón.
3. Địa chỉ GPKD chỉ lấy phần sau “Trụ sở của hộ kinh doanh:” (hoặc anchor tương đương), ghép tối đa 1–3 dòng và dừng trước Điện thoại/Fax/Website/Ngành nghề.
4. Nơi cấp CCHND: ưu tiên tên tỉnh/thành ở phần đầu chứng chỉ và chuẩn hóa thành “SỞ Y TẾ <TỈNH/THÀNH>”. Ví dụ UBND TỈNH TIỀN GIANG -> SỞ Y TẾ TIỀN GIANG. Không lấy Nơi cấp CMND/CCCD.
5. Thêm trường “Người PTCM”, lấy tên người ở dòng “Chứng nhận: Ông/Bà ...” trên CCHND. Tổng số trường: 14.
6. Giữ nguyên database IndexedDB tên GPPDataEntryLiteV1 nên hồ sơ V1/V1.1 vẫn mở được. Hồ sơ cũ sẽ tự có thêm trường Người PTCM trống để nhập/scan bổ sung.

CÁCH CHẠY
- Cách nhanh: mở index.html.
- Khuyến nghị: chạy START_GPP_V1.bat nếu máy có Node.js; sau đó mở http://localhost:8787.
- Lần đầu OCR cần Internet để tải/cache Tesseract.js và model tiếng Việt từ CDN.

NGUYÊN TẮC
- Người dùng chọn đúng loại tài liệu trước khi chụp/upload.
- OCR chỉ đề xuất; tất cả ô đều sửa/nhập trực tiếp được.
- Không chắc thì để trống, không tự đoán.
- Mỗi trường OCR có thể bấm để xem vùng bằng chứng trên ảnh.
