/* GPP Data Entry Lite V1.2.18
   Giữ nguyên toàn bộ cấu trúc, OCR và rule của V1.2.16 FINAL.
   V1.2.18 giữ nguyên OCR/rule V1.2.17; chỉ bổ sung giao diện Android/PWA, camera toàn màn hình + crop theo khung và logo.
*/
const DOCS = {
  cchnd: {name:'Chứng chỉ hành nghề dược', fields:['so_cchnd','ngay_cap_cchnd','noi_cap_cchnd','nguoi_ptcm']},
  gpkd: {name:'Giấy phép kinh doanh', fields:['ten_co_so','loai_co_so','dien_thoai','dia_chi']},
  bang: {name:'Bằng tốt nghiệp', fields:['nam_cap_bang','truong_tot_nghiep']},
  ddkkdd: {name:'Giấy đủ điều kiện kinh doanh dược', fields:['so_ddkkdd','ngay_cap_ddkkdd']},
  gpp: {name:'Giấy GPP – Thực hành tốt', fields:['so_gpp','ngay_cap_gpp']}
};
const FIELDS = {
  so_cchnd:'Số CCHND', ngay_cap_cchnd:'Ngày cấp CCHND', noi_cap_cchnd:'Nơi cấp CCHND', nguoi_ptcm:'Người PTCM',
  ten_co_so:'Tên cơ sở', loai_co_so:'Loại cơ sở', dien_thoai:'Số điện thoại', dia_chi:'Địa chỉ',
  nam_cap_bang:'Năm cấp bằng', truong_tot_nghiep:'Trường tốt nghiệp',
  so_ddkkdd:'Số ĐĐKKDD', ngay_cap_ddkkdd:'Ngày cấp ĐĐKKDD', so_gpp:'Số GPP', ngay_cap_gpp:'Ngày cấp GPP'
};
const FIELD_ORDER = Object.keys(FIELDS);

/* V1.2.10 - LỚP NHẬN DIỆN BỔ SUNG (PASSIVE / SAFE)
   - Nền OCR + rule của V1.2.8 giữ nguyên.
   - Không đổi PSM, không OCR thêm, không thay ROI, không can thiệp trường Bằng/CCHND/GPP/ĐĐKKDD.
   - Chỉ đọc lại chính các dòng OCR mà V1.2.8 đã tạo để nhận dạng profile biểu mẫu.
   - Chỉ được phép sửa DẤU tên cơ sở khi ít nhất 2 giấy hỗ trợ cùng xác nhận và chuỗi KHÔNG DẤU trùng tuyệt đối.
*/
const DOCUMENT_PROFILES_V1210 = {
  cchnd:{anchors:[['chung chi hanh nghe duoc'],['so hieu'],['chung nhan']]},
  gpkd:{anchors:[['giay chung nhan dang ky ho kinh doanh'],['ten ho kinh doanh'],['tru so cua ho kinh doanh']]},
  bang:{anchors:[['bang tot nghiep'],['truong'],['ngay','nam']]},
  ddkkdd:{anchors:[['du dieu kien kinh doanh duoc'],['so']]},
  gpp:{anchors:[['thuc hanh tot'],['gpp']]}
};
let state = freshState();
let activeDoc = null, pendingDoc = null, worker = null, activeImage = null;
// V1.2.1: activeImage CHỈ dùng để xem ảnh. OCR luôn dùng ảnh khóa trong từng job.
let ocrQueue = [], ocrQueueRunning = false;
// V1.2.17: logger Tesseract cập nhật thanh tiến trình của đúng job đang chạy.
let activeOCRProgressDocType = null;
let previewZoom = 1, currentEvidence = null, lastPreviewScale = 1;
const $ = s => document.querySelector(s);

function documentOCRProgress(doc){
  if(!doc)return 0;
  if(doc.ocrState==='done')return 100;
  if(!doc.ocrState&&doc.ocrText)return 100;
  const n=Number(doc.ocrProgress||0);return Math.max(0,Math.min(100,Math.round(n)));
}
function documentOCRStatus(doc){
  if(!doc)return 'Chưa có';
  if(doc.ocrState==='done')return '✓ Hoàn tất';
  if(doc.ocrState==='error')return 'Lỗi OCR';
  if(doc.ocrState==='queued')return `Chờ OCR • ${documentOCRProgress(doc)}%`;
  if(doc.ocrState==='running')return `${doc.ocrStage||'Đang OCR'} • ${documentOCRProgress(doc)}%`;
  return '✓ Đã có ảnh';
}
function updateDocumentProgressUI(docType){
  const card=document.querySelector(`[data-drop-doc=\"${docType}\"]`);if(!card)return;
  const doc=state.documents?.[docType],p=documentOCRProgress(doc);
  const track=card.querySelector('.doc-progress-track'),fill=card.querySelector('.doc-progress-fill'),status=card.querySelector('.doc-status');
  if(track){track.setAttribute('aria-valuenow',String(p));track.dataset.state=doc?.ocrState||'empty';}
  if(fill)fill.style.width=`${p}%`;
  if(status)status.textContent=documentOCRStatus(doc);
}
function setDocumentOCRProgress(docType,value,stage=''){
  const doc=state.documents?.[docType];if(!doc)return;
  let next=Math.max(0,Math.min(100,Math.round(Number(value)||0)));
  const prev=documentOCRProgress(doc);
  // Trong lúc OCR chỉ tăng, không giật lùi khi Tesseract bắt đầu một lượt nhận dạng phụ.
  if(doc.ocrState==='running'||doc.ocrState==='queued')next=Math.max(prev,next);
  doc.ocrProgress=next;if(stage)doc.ocrStage=stage;
  updateDocumentProgressUI(docType);
}
function handleOCRProgressLogger(m){
  if(m.status)$('#ocrStatus').textContent=`${m.status} ${m.progress?Math.round(m.progress*100)+'%':''}`;
  const docType=activeOCRProgressDocType,doc=docType&&state.documents?.[docType];if(!doc)return;
  const p=Number(m.progress);if(!Number.isFinite(p))return;
  if(/recogniz/i.test(String(m.status||'')))setDocumentOCRProgress(docType,12+p*54,'Đang nhận dạng');
  else if(documentOCRProgress(doc)<12)setDocumentOCRProgress(docType,4+p*8,'Đang nạp OCR');
}

function freshField(){ return {value:'',confidence:0,evidence:null,verified:false}; }

/* V1.2.12 - "Ban hành" là metadata của HỒ SƠ LƯU, không phải trường OCR.
   Quy tắc mặc định:
   - đủ đúng 5 loại giấy => Ban Hành Lần 01
   - đúng 3 giấy CCHND + GPKD + Bằng tốt nghiệp => Ban Hành Lần 02
   - tổ hợp khác => để trống
   Khi người dùng sửa thủ công, manual=true và phần mềm không tự ghi đè nữa. */
function inferBanHanh(documents={}){
  const present=Object.keys(documents||{}).filter(k=>Object.prototype.hasOwnProperty.call(DOCS,k));
  const set=new Set(present);
  const all5=Object.keys(DOCS).every(k=>set.has(k))&&set.size===5;
  if(all5)return 'Ban Hành Lần 01';
  const only3=set.size===3&&set.has('gpkd')&&set.has('cchnd')&&set.has('bang');
  if(only3)return 'Ban Hành Lần 02';
  return '';
}
function normalizeBanHanh(rawBanHanh,documents={}){
  if(rawBanHanh&&typeof rawBanHanh==='object')return {value:String(rawBanHanh.value||''),manual:!!rawBanHanh.manual};
  if(typeof rawBanHanh==='string')return {value:rawBanHanh,manual:true};
  return {value:inferBanHanh(documents),manual:false};
}
function refreshBanHanhDefault(){
  state.banHanh=normalizeBanHanh(state.banHanh,state.documents);
  if(!state.banHanh.manual)state.banHanh.value=inferBanHanh(state.documents);
}
function freshState(){ return {id:crypto.randomUUID(), createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(), fields:Object.fromEntries(FIELD_ORDER.map(k=>[k,freshField()])), documents:{}, banHanh:{value:'',manual:false}}; }
function hydrateState(raw){
  const base=freshState();
  if(!raw)return base;
  base.id=raw.id||base.id;base.createdAt=raw.createdAt||base.createdAt;base.updatedAt=raw.updatedAt||base.updatedAt;
  base.documents=raw.documents||{};
  base.banHanh=normalizeBanHanh(raw.banHanh,base.documents);
  FIELD_ORDER.forEach(k=>{base.fields[k]={...freshField(),...(raw.fields?.[k]||{})};});
  return base;
}
function toast(msg){const t=$('#toast');t.textContent=msg;t.classList.add('show');clearTimeout(toast._t);toast._t=setTimeout(()=>t.classList.remove('show'),2600)}
function esc(s=''){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
function normalize(s=''){return String(s).normalize('NFC').replace(/\s+/g,' ').trim()}
function noAccent(s=''){return normalize(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/g,'d').replace(/Đ/g,'D').toLowerCase()}

/* V1.2.11 - NHẬN HƯỚNG GIẤY BẰNG ANCHOR, KHÔNG DÙNG TỌA ĐỘ.
   Chỉ kích hoạt khi OCR hướng hiện tại không nhận đủ "dấu vân tay" của loại giấy.
   Sau khi chọn hướng tốt nhất, toàn bộ rule V1.2.8/V1.2.10 chạy nguyên như cũ. */
const ORIENTATION_HINTS_V1211 = {
  cchnd:[
    ['chung chi hanh nghe duoc',8],['hanh nghe duoc',4],['so hieu',2],['chung nhan',2],
    ['cap lan dau',3],['so y te',2],['cchn',4],['ngay sinh',1.5],['noi cap',1.5]
  ],
  gpkd:[
    ['giay chung nhan dang ky ho kinh doanh',9],['dang ky ho kinh doanh',6],['ten ho kinh doanh',4],
    ['tru so cua ho kinh doanh',4],['ma so ho kinh doanh',3],['nganh nghe kinh doanh',2],['dien thoai',1]
  ],
  bang:[
    ['bang tot nghiep',8],['bang duoc si',8],['duoc si',4],['cap bang',3],['hieu truong',3],
    ['truong cao dang',3],['truong dai hoc',3],['diploma',4],['degree of pharmacist',8],
    ['pharmacist',5],['university',2],['college',2],['rector',2],['date of birth',1.5],['ngay sinh',1.5]
  ],
  ddkkdd:[
    ['giay chung nhan du dieu kien kinh doanh duoc',10],['du dieu kien kinh doanh duoc',7],
    ['kinh doanh duoc',3],['nguoi chiu trach nhiem chuyen mon',3],['so y te',2],['ddkkdd',4],['dkkdd',4]
  ],
  gpp:[
    ['giay chung nhan dat thuc hanh tot',9],['thuc hanh tot',6],['co so ban le thuoc',5],
    ['good pharmacy practices',7],['good pharmacy practice',6],['gpp',5],['so y te',2],
    ['giam doc so y te chung nhan',3],['dat thuc hanh tot',4]
  ]
};
function orientationTextQualityV1213(text='',confidence=0){
  const raw=String(text||'').replace(/\r/g,'');
  const lines=raw.split(/\n+/).map(normalize).filter(Boolean);
  const words=(noAccent(raw).match(/[a-z]{2,}/g)||[]);
  const usefulLines=lines.filter(x=>(noAccent(x).match(/[a-z]{2,}/g)||[]).length>=3).length;
  // Chất lượng OCR chỉ là điểm phụ; không được tự nó đủ để coi giấy đã đúng hướng.
  let q=Math.max(0,Math.min(2.5,Number(confidence||0)/28));
  q+=Math.min(1.4,words.length/45);
  q+=Math.min(1.1,usefulLines/8);
  return q;
}
function orientationAnchorScoreV1211(docType,text='',confidence=0){
  const n=noAccent(text);let score=orientationTextQualityV1213(text,confidence);
  for(const [term,w] of (ORIENTATION_HINTS_V1211[docType]||[]))if(n.includes(term))score+=w;
  if(docType==='gpp'&&numberFrom(text,'gpp'))score+=5;
  if(docType==='cchnd'&&numberFrom(text,'cchnd'))score+=4;
  if(docType==='ddkkdd'&&numberFrom(text,'ddkkdd'))score+=4;
  if(formatDateText(text))score+=1.5;
  return score;
}
function orientationGoodEnoughV1211(docType,score){
  const threshold={cchnd:10,gpkd:11,bang:9,ddkkdd:10,gpp:11}[docType]||10;
  return score>=threshold;
}
function rotateCanvasV1211(image,degrees,maxSide=0){
  const iw=image.naturalWidth||image.width,ih=image.naturalHeight||image.height;
  const scale=maxSide>0?Math.min(1,maxSide/Math.max(iw,ih)):1;
  const sw=Math.max(1,Math.round(iw*scale)),sh=Math.max(1,Math.round(ih*scale));
  const src=document.createElement('canvas');src.width=sw;src.height=sh;src.getContext('2d').drawImage(image,0,0,sw,sh);
  const d=((degrees%360)+360)%360,c=document.createElement('canvas');
  if(d===90||d===270){c.width=sh;c.height=sw;}else{c.width=sw;c.height=sh;}
  const x=c.getContext('2d');
  if(d===90){x.translate(c.width,0);x.rotate(Math.PI/2);}
  else if(d===180){x.translate(c.width,c.height);x.rotate(Math.PI);}
  else if(d===270){x.translate(0,c.height);x.rotate(-Math.PI/2);}
  x.drawImage(src,0,0);return c;
}
function canvasToImageV1211(canvas,job){
  return new Promise((resolve,reject)=>canvas.toBlob(async blob=>{
    if(!blob){reject(new Error('Không tạo được ảnh xoay'));return;}
    const url=URL.createObjectURL(blob);job.tempObjectUrls=job.tempObjectUrls||[];job.tempObjectUrls.push(url);
    try{resolve(await loadImage(url));}catch(e){reject(e);}
  },'image/jpeg',0.94));
}
async function chooseOCROrientationV1211(job,w,initialResult){
  const docType=job.documentType,baseText=initialResult?.data?.text||'',baseConf=initialResult?.data?.confidence||0;
  const baseScore=orientationAnchorScoreV1211(docType,baseText,baseConf);
  if(orientationGoodEnoughV1211(docType,baseScore))return {image:job.image,result:initialResult,rotation:0,score:baseScore};
  let best={rotation:0,score:baseScore,result:initialResult};
  for(const deg of [90,270,180]){
    if(!isJobCurrent(job))return {image:job.image,result:initialResult,rotation:0,score:baseScore};
    $('#ocrStatus').textContent=`Đang kiểm tra hướng giấy ${DOCS[docType].name}: ${deg}°...`;
    try{
      const probe=rotateCanvasV1211(job.image,deg,1300),r=await w.recognize(probe);
      const sc=orientationAnchorScoreV1211(docType,r?.data?.text||'',r?.data?.confidence||0);
      if(sc>best.score)best={rotation:deg,score:sc,result:r};
      if(orientationGoodEnoughV1211(docType,sc))break;
    }catch(e){console.warn('Kiểm tra hướng OCR:',deg,e);}
  }
  // V1.2.13: mẫu cũ/bằng song ngữ có thể ít anchor nhưng hướng đúng vẫn tạo ra nhiều từ/dòng hợp lệ hơn.
  // Chỉ xoay khi hướng khác tốt hơn rõ rệt; không thay đổi bất kỳ rule trích xuất dữ liệu nào.
  const minGain=1.35;
  if(best.rotation===0||best.score<baseScore+minGain)return {image:job.image,result:initialResult,rotation:0,score:baseScore};
  const fullCanvas=rotateCanvasV1211(job.image,best.rotation,0),rotatedImage=await canvasToImageV1211(fullCanvas,job);
  if(!isJobCurrent(job))return {image:job.image,result:initialResult,rotation:0,score:baseScore};
  $('#ocrStatus').textContent=`Đã tự xoay ${best.rotation}°; đang OCR ${DOCS[docType].name}...`;
  const fullResult=await w.recognize(rotatedImage,{}, {blocks:true});
  return {image:rotatedImage,result:fullResult,rotation:best.rotation,score:orientationAnchorScoreV1211(docType,fullResult?.data?.text||'',fullResult?.data?.confidence||0)};
}
function formatDateText(s=''){
  const m=String(s).match(/(\d{1,2})\s*[\/\.\-]\s*(\d{1,2})\s*[\/\.\-]\s*(\d{4})/); if(m) return `${m[1].padStart(2,'0')}/${m[2].padStart(2,'0')}/${m[3]}`;
  const v=noAccent(s).match(/ngay\s*(\d{1,2})\s*thang\s*(\d{1,2})\s*nam\s*(\d{4})/); if(v) return `${v[1].padStart(2,'0')}/${v[2].padStart(2,'0')}/${v[3]}`;
  return '';
}
function validDate(v=''){
  const m=v.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);if(!m)return false;
  const d=+m[1],mo=+m[2],y=+m[3];if(y<1900||y>2100)return false;
  const dt=new Date(y,mo-1,d);return dt.getFullYear()===y&&dt.getMonth()===mo-1&&dt.getDate()===d;
}
function lineObjects(result){
  const out=[];
  try{(result.data.blocks||[]).forEach(b=>(b.paragraphs||[]).forEach(p=>(p.lines||[]).forEach(l=>out.push({text:normalize(l.text),bbox:l.bbox,confidence:l.confidence||0}))));}catch(e){}
  if(!out.length){(result.data.text||'').split(/\n+/).map(normalize).filter(Boolean).forEach((text,i)=>out.push({text,bbox:null,confidence:70,order:i}));}
  return out;
}
function linePosition(line,idx,total,image=null){
  if(line?.bbox&&image?.naturalHeight){const y=(line.bbox.y0+line.bbox.y1)/2;return Math.max(0,Math.min(1,y/image.naturalHeight));}
  return idx/Math.max(1,total-1);
}
function lineXPosition(line,image=null){
  if(line?.bbox&&image?.naturalWidth){const x=(line.bbox.x0+line.bbox.x1)/2;return Math.max(0,Math.min(1,x/image.naturalWidth));}
  return .5;
}
function unionEvidenceLines(items){
  const rows=(items||[]).filter(Boolean);if(!rows.length)return null;
  const boxes=rows.map(x=>x.bbox).filter(Boolean);let bbox=null;if(boxes.length){bbox={x0:Math.min(...boxes.map(b=>b.x0)),y0:Math.min(...boxes.map(b=>b.y0)),x1:Math.max(...boxes.map(b=>b.x1)),y1:Math.max(...boxes.map(b=>b.y1))};}
  return {text:rows.map(x=>x.text).join(' '),bbox,confidence:Math.round(rows.reduce((a,x)=>a+(x.confidence||65),0)/rows.length),score:Math.round(rows.reduce((a,x)=>a+(x.confidence||65),0)/rows.length)};
}
function scoreLine(line, idx, total, {include=[],exclude=[],top=false,bottom=false,pattern=null,image=null}={}){
  const n=noAccent(line.text);let s=(line.confidence||60)*0.45;
  include.forEach(k=>{if(n.includes(noAccent(k)))s+=18});exclude.forEach(k=>{if(n.includes(noAccent(k)))s-=50});
  if(pattern&&pattern.test(line.text))s+=25;
  const pos=linePosition(line,idx,total,image);if(top)s+=(1-pos)*22;if(bottom)s+=pos*22;return s;
}
function best(lines,cfg){let winner=null;lines.forEach((l,i)=>{const score=scoreLine(l,i,lines.length,cfg);if(!winner||score>winner.score)winner={...l,score,index:i}});return winner}
function findNearby(lines,anchors,radius=2){
  const hits=[];lines.forEach((l,i)=>{const n=noAccent(l.text);if(anchors.some(a=>n.includes(noAccent(a))))for(let j=Math.max(0,i-radius);j<=Math.min(lines.length-1,i+radius);j++)hits.push({...lines[j],anchorIndex:i,index:j});});return hits;
}
function numberFrom(text,kinds){
  const clean=normalize(text);const patterns={
    cchnd:/\b[0-9A-Z.\-]+\s*\/\s*[A-ZĐDKHNC\-]{3,}(?:-[A-ZĐ0-9\-]+)?\b/i,
    ddkkdd:/\b[0-9A-Z.\-]+\s*\/\s*(?:Đ?D?K?K?D?D|DKKDD|GCN-?DDK)[A-ZĐ0-9\-]*\b/i,
    gpp:/\b[0-9A-Z.\-]+\s*\/\s*(?:GCN-?)?GPP[A-ZĐ0-9\-]*\b/i
  };
  const m=clean.match(patterns[kinds]);return m?m[0].replace(/\s+/g,''):'';
}
function phoneFrom(text){const m=String(text).replace(/[ .()\-]/g,'').match(/(?:\+84|0)\d{8,10}/);return m?m[0].replace(/^\+84/,'0'):''}
function gppNumberTokenV1215(text='',allowGeneric=false){
  const raw=normalize(text).replace(/[\\|]/g,'/');
  // Chịu khoảng trắng OCR: 4937 / GCN - GPP, 4937/G P P, 4937 / GPP-TG...
  let m=raw.match(/\b([0-9]{1,7}[A-Z0-9.\-]*)\s*\/\s*((?:GCN\s*[-–—]?\s*)?G\s*P\s*P(?:\s*[-–—]?\s*[A-ZĐ0-9]{1,12})*)\b/i);
  if(m){
    let suffix=m[2].replace(/\s+/g,'').replace(/[–—]/g,'-').replace(/^GCN-?/i,'GCN-').replace(/^GPP/i,'GPP');
    suffix=suffix.replace(/G[- ]?P[- ]?P/i,'GPP');
    return `${m[1]}/${suffix}`.toUpperCase();
  }
  if(!allowGeneric)return '';
  // Fallback CHỈ dùng trong ngữ cảnh đã xác nhận là dòng Số của giấy GPP.
  // Không đoán ngày; bắt buộc có mã dạng số/chữ + '/' + hậu tố chữ.
  m=raw.match(/\b([0-9]{1,7}[A-Z0-9.\-]*)\s*\/\s*([A-ZĐ]{2,}(?:\s*[-–—]?\s*[A-ZĐ0-9]{1,12}){0,4})\b/i);
  if(!m)return '';
  const token=`${m[1]}/${m[2].replace(/\s+/g,'').replace(/[–—]/g,'-')}`.toUpperCase();
  if(/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(token))return '';
  return token;
}
function isGPPTextAnchorV1215(text=''){
  const n=noAccent(text);
  return n.includes('thuc hanh tot')||n.includes('good pharmacy')||n.includes('co so ban le thuoc')||/\bgpp\b/.test(n);
}
function isNumberLabelV1215(text=''){
  const raw=normalize(text),n=noAccent(raw);
  if(/\bsố\s*(?:hiệu)?\s*[:：]/i.test(raw))return true;
  if(/\bso\s*(?:hieu)?\s*[:：]/i.test(n))return true;
  // Nhãn và số có thể dính nhau nhưng loại SỞ Y TẾ sau khi bỏ dấu.
  return /\bso\s*(?:hieu\s*)?[0-9]/i.test(n)&&!n.includes('so y te');
}
function extractGPPNumberV1215(lines){
  const rows=lines||[];if(!rows.length)return null;
  const anchorIdx=[];rows.forEach((l,i)=>{if(isGPPTextAnchorV1215(l.text))anchorIdx.push(i)});
  let bestHit=null;
  for(let i=0;i<rows.length;i++){
    for(let span=1;span<=3&&i+span<=rows.length;span++){
      const ev=unionEvidenceLines(rows.slice(i,i+span));if(!ev)continue;
      const direct=gppNumberTokenV1215(ev.text,false);
      const hasLabel=isNumberLabelV1215(ev.text);
      const dist=anchorIdx.length?Math.min(...anchorIdx.map(a=>Math.abs(a-i))):99;
      const nearGPP=dist<=7||isGPPTextAnchorV1215(ev.text);
      const generic=(!direct&&hasLabel&&nearGPP)?gppNumberTokenV1215(ev.text,true):'';
      const value=direct||generic;if(!value)continue;
      let score=(ev.confidence||60)+(direct?28:12)+(hasLabel?14:0)+(nearGPP?Math.max(2,12-dist):0)-i*.03;
      // Tránh nhầm mã CCHN/ĐKKDD tham chiếu xuất hiện trong nội dung giấy.
      const vn=noAccent(value);if(vn.includes('cchn')||vn.includes('dkkdd')||vn.includes('ddkkdd'))score-=45;
      if(!bestHit||score>bestHit.score)bestHit={value,line:{...ev,score},score,index:i};
    }
  }
  return bestHit;
}
function findGPPNumberAnchorV1215(lines){
  const rows=lines||[],gpp=[];rows.forEach((l,i)=>{if(isGPPTextAnchorV1215(l.text))gpp.push(i)});
  let bestHit=null;
  rows.forEach((l,i)=>{
    if(!l?.bbox||!isNumberLabelV1215(l.text))return;
    const dist=gpp.length?Math.min(...gpp.map(a=>Math.abs(a-i))):99;if(dist>9)return;
    const score=(l.confidence||55)+Math.max(0,24-dist*3)+(gppNumberTokenV1215(l.text,false)?25:0);
    if(!bestHit||score>bestHit.score)bestHit={...l,index:i,score};
  });
  // Nếu OCR mất nhãn Số:, dùng chính tiêu đề GPP làm neo để tạo ROI động lân cận.
  if(!bestHit&&gpp.length){
    const i=gpp[0],l=rows[i];if(l?.bbox)bestHit={...l,index:i,score:(l.confidence||55),gppTitleFallback:true};
  }
  return bestHit;
}
function evidenceOf(line){return line?{bbox:line.bbox||null,text:line.text,confidence:Math.max(0,Math.min(99,Math.round(line.score||line.confidence||0)))}:null}
function setField(key,value,line,bonus=0){
  if(!value)return;// OCR tự động không được gắn 99% chỉ vì Tesseract/rule cùng tự tin; 100% chỉ dành cho người dùng đã sửa/xác nhận.
  const val=normalize(value),conf=Math.max(1,Math.min(96,Math.round((line?.score||line?.confidence||65)+bonus)));const cur=state.fields[key];
  if(cur.verified)return;
  if(!cur.value){state.fields[key]={value:val,confidence:conf,evidence:evidenceOf(line),verified:false};return;}
  if(noAccent(cur.value)===noAccent(val)){
    if(conf>cur.confidence)state.fields[key]={value:val,confidence:conf,evidence:evidenceOf(line),verified:false};
    return;
  }
  // Không cho một lượt OCR chạy sau nhưng kém tin cậy ghi đè kết quả tốt hơn.
  if(conf>cur.confidence)state.fields[key]={value:val,confidence:conf,evidence:evidenceOf(line),verified:false};
}
function clearField(k){state.fields[k]=freshField();}
function clearDocumentFields(docType){(DOCS[docType]?.fields||[]).forEach(clearField);}

/* Ngày cấp: theo yêu cầu V1.1, ưu tiên khu vực chữ ký/phần cuối cho tất cả giấy có ngày cấp. */
function findSignatureDate(lines,{exclude=[],image=null}={}){
  let candidates=[];
  lines.forEach((l,i)=>{
    const date=formatDateText(l.text);if(!date||!validDate(date))return;
    const n=noAccent(l.text);if(exclude.some(x=>n.includes(noAccent(x))))return;
    const pos=linePosition(l,i,lines.length,image);
    let score=(l.confidence||60)*0.35+pos*45;
    if(pos>=0.55)score+=18;if(/ngay|thang|nam/.test(n))score+=18;if(/ky|giam doc|pho giam doc|hieu truong|truong phong/.test(n))score+=8;
    candidates.push({...l,date,score,index:i,pos});
  });
  candidates.sort((a,b)=>b.score-a.score);
  return candidates[0]||null;
}

const LOCALITIES = [
  'AN GIANG','BÀ RỊA - VŨNG TÀU','BẮC GIANG','BẮC KẠN','BẠC LIÊU','BẮC NINH','BẾN TRE','BÌNH ĐỊNH','BÌNH DƯƠNG','BÌNH PHƯỚC','BÌNH THUẬN','CÀ MAU','CAO BẰNG','ĐẮK LẮK','ĐẮK NÔNG','ĐIỆN BIÊN','ĐỒNG NAI','ĐỒNG THÁP','GIA LAI','HÀ GIANG','HÀ NAM','HÀ TĨNH','HẢI DƯƠNG','HẬU GIANG','HÒA BÌNH','HƯNG YÊN','KHÁNH HÒA','KIÊN GIANG','KON TUM','LAI CHÂU','LÂM ĐỒNG','LẠNG SƠN','LÀO CAI','LONG AN','NAM ĐỊNH','NGHỆ AN','NINH BÌNH','NINH THUẬN','PHÚ THỌ','QUẢNG BÌNH','QUẢNG NAM','QUẢNG NGÃI','QUẢNG NINH','QUẢNG TRỊ','SÓC TRĂNG','SƠN LA','TÂY NINH','THÁI BÌNH','THÁI NGUYÊN','THANH HÓA','THỪA THIÊN HUẾ','TIỀN GIANG','TRÀ VINH','TUYÊN QUANG','VĨNH LONG','VĨNH PHÚC','YÊN BÁI','CẦN THƠ','ĐÀ NẴNG','HẢI PHÒNG','HÀ NỘI','THÀNH PHỐ HỒ CHÍ MINH','HỒ CHÍ MINH','HUẾ'
];
function canonicalLocality(text=''){
  const n=noAccent(text);const hit=LOCALITIES.slice().sort((a,b)=>b.length-a.length).find(x=>n.includes(noAccent(x)));return hit||'';
}
function extractIssuer(lines){
  const top=lines.slice(0,Math.max(8,Math.ceil(lines.length*.36)));
  // V1.2.3: CCHND chỉ cần đọc đầu giấy. Nếu thấy UBND + tên tỉnh/thành phố,
  // chuẩn hóa thẳng thành "SỞ Y TẾ <địa phương>" như yêu cầu người dùng.
  const topText=top.map(x=>x.text).join(' '),topNorm=noAccent(topText);
  if(topNorm.includes('ubnd')||topNorm.includes('uy ban nhan dan')||topNorm.includes('so y te')){
    const loc=canonicalLocality(topText);
    if(loc)return {value:`SỞ Y TẾ ${loc}`,line:unionEvidenceLines(top)};
  }
  // Fallback theo cửa sổ 1-4 dòng để chịu được OCR tách dòng / sai thứ tự nhẹ.
  for(let i=0;i<top.length;i++){
    for(let span=1;span<=4&&i+span<=top.length;span++){
      const rows=top.slice(i,i+span),text=rows.map(x=>x.text).join(' '),n=noAccent(text);
      if(!(n.includes('ubnd')||n.includes('uy ban nhan dan')||n.includes('so y te')))continue;
      const loc=canonicalLocality(text);if(loc)return {value:`SỞ Y TẾ ${loc}`,line:unionEvidenceLines(rows)};
    }
  }
  return null;
}
function gpkdAnchorText(text=''){
  return noAccent(text).replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
}
function isBusinessNameAnchor(text=''){
  // Vẫn bắt buộc đúng ý nghĩa nhãn "Tên hộ kinh doanh viết bằng tiếng Việt",
  // nhưng chịu được OCR sai dấu / dấu câu / mất một vài từ nối.
  const n=gpkdAnchorText(text);
  if(!n.includes('ten ho kinh doanh'))return false;
  if(n.includes('tieng viet'))return true;
  // Chấp nhận OCR sai nhẹ ở chữ Việt nhưng vẫn phải có cả cụm "viết bằng tiếng...";
  // không coi dòng mới dừng ở "viết bằng" là nhãn hoàn chỉnh.
  return /ten ho kinh doanh[\s\S]{0,45}\bviet\s+bang\s+tieng\s+vie[a-z0-9]*/.test(n);
}
function isExactBusinessNameAnchor(text=''){return isBusinessNameAnchor(text)}
function stripAfterBusinessNameAnchor(text=''){
  let t=normalize(text).replace(/^\s*\d+\s*[.\)]\s*/,'');
  if(!isBusinessNameAnchor(t))return '';
  // Nếu OCR ghép cả "1. Tên hộ kinh doanh:" và nhãn chi tiết vào cùng một dòng,
  // dấu ':' cuối cùng mới là mốc cần lấy dữ liệu.
  const colon=Math.max(t.lastIndexOf(':'),t.lastIndexOf('：'));
  if(colon>=0)return t.slice(colon+1).replace(/^\s*[:：\-–—|]+\s*/,'').trim();
  const n=noAccent(t),viet=n.lastIndexOf('viet');
  if(viet>=0)return t.slice(viet+4).replace(/^\s*[:：\-–—|]+\s*/,'').trim();
  return '';
}
function isBusinessNameStop(text=''){
  const raw=normalize(text),n=gpkdAnchorText(raw);
  // Chặn mạnh ngay khi sang mục 2, kể cả OCR làm hỏng phần "kinh doanh".
  if(/(^|\s)2\s*[.\)]\s*/.test(raw))return true;
  if(/\b2\s*[.\)]?\s*tru\s*so\b/.test(n))return true;
  if(n.includes('tru so cua ho kinh')||n.includes('tru so cua ho'))return true;
  return n.includes('dia diem kinh doanh')||n.includes('dia chi kinh doanh')||n.includes('ten ho kinh doanh bang tieng nuoc ngoai')||n.includes('ten viet tat')||n.includes('ma so ho kinh doanh');
}
function businessNameStopIndex(text=''){
  const t=normalize(text),n=noAccent(t);
  const regexes=[
    /\b2\s*[.\)]?\s*tru\s*so\b/,
    /\btru\s*so\s*cua\s*ho\s*kinh\b/,
    /\btru\s*so\s*cua\s*ho\b/,
    /\bdia\s*diem\s*kinh\s*doanh\b/,
    /\bdia\s*chi\s*kinh\s*doanh\b/,
    /\bten\s*ho\s*kinh\s*doanh\s*bang\s*tieng\s*nuoc\s*ngoai\b/,
    /\bten\s*viet\s*tat\b/,
    /\bma\s*so\s*ho\s*kinh\s*doanh\b/
  ];
  let pos=-1;
  for(const re of regexes){const m=n.match(re);if(m&&m.index>=0&&(pos<0||m.index<pos))pos=m.index;}
  // Nếu phrase mục 2 bị OCR hỏng nặng nhưng vẫn còn số thứ tự "2.", đây vẫn là biên an toàn.
  const m2=n.match(/\b2\s*[.\)]\s*/);if(m2&&m2.index>=0&&(pos<0||m2.index<pos))pos=m2.index;
  return pos;
}
function cutBusinessNameStop(text=''){
  const t=normalize(text),pos=businessNameStopIndex(t);
  return {text:(pos>=0?t.slice(0,pos):t).replace(/^[|:;,.-\s]+|[|:;,.-\s]+$/g,'').trim(),stopped:pos>=0};
}
function cleanBusinessNameChunk(text=''){
  let t=cutBusinessNameStop(text).text;
  // Watermark của GPKD đôi khi bị OCR dính vào CUỐI tên trên cùng một dòng.
  // Cắt tại ký hiệu bất thường; sau đó phát hiện chuỗi nhiều token 1-2 ký tự kiểu "NC VN S TI...".
  const weird=t.search(/[“”"<>^ˆ=~{}\[\]\\]/);if(weird>=0)t=t.slice(0,weird);
  let toks=t.replace(/^[|:;,.-\s]+|[|:;,.-\s]+$/g,'').replace(/\s{2,}/g,' ').trim().split(/\s+/).filter(Boolean);
  for(let i=0;i<toks.length;i++){
    const win=toks.slice(i,i+4).map(x=>noAccent(x).replace(/[^a-z0-9]/g,''));
    const tiny=win.filter(x=>x&&x.length<=2).length;
    if(win.length>=3&&tiny>=3&&i>=3){toks=toks.slice(0,i);break;}
  }
  while(toks.length>3){const z=noAccent(toks[toks.length-1]).replace(/[^a-z]/g,'');if(z&&z.length<=3&&!/[aeiouy]/.test(z))toks.pop();else break;}
  return toks.join(' ').trim();
}
function isPlausibleBusinessNameChunk(text=''){
  const t=cleanBusinessNameChunk(text);if(!t)return false;
  const n=noAccent(t);
  if(isBusinessNameStop(t)||/dien thoai|fax|website|thu dien tu|thua dat|so nha|\bap\b/.test(n))return false;
  const token=noAccent(t).replace(/[^a-z]/g,'');
  if(token.length<=3&&!/[aeiouy]/.test(token))return false;
  const chars=[...t],letters=chars.filter(c=>/\p{L}/u.test(c)).length,digits=chars.filter(c=>/\d/.test(c)).length,bad=chars.filter(c=>!/[\p{L}\d\s&'’().,+\-/]/u.test(c)).length;
  if(letters<2)return false;
  if(bad>2)return false;
  if(digits>Math.max(3,Math.floor(chars.length*.18)))return false;
  return letters/Math.max(1,chars.length)>=.52;
}
function extractBusinessName(lines){
  // Chỉ lấy sau nhãn "Tên hộ kinh doanh viết bằng tiếng Việt:".
  // Tuyệt đối không cho dữ liệu tràn sang mục 2 / địa chỉ.
  for(let i=0;i<lines.length;i++){
    for(let span=1;span<=3&&i+span<=lines.length;span++){
      const anchorRows=lines.slice(i,i+span),anchorText=anchorRows.map(x=>x.text).join(' ');
      if(!isBusinessNameAnchor(anchorText))continue;
      const used=[...anchorRows],parts=[],continuationRows=[];
      const firstRaw=stripAfterBusinessNameAnchor(anchorText),firstCut=cutBusinessNameStop(firstRaw);
      if(firstCut.text&&isPlausibleBusinessNameChunk(firstCut.text))parts.push(cleanBusinessNameChunk(firstCut.text));
      if(firstCut.stopped){
        const value=canonicalStructuredBusinessName(normalize(parts.join(' ')));
        if(value.length>=3){const ev=unionEvidenceLines(used);if(ev)ev.score=Math.max(ev.confidence||0,90);return {value,line:ev,exact:true,continuationRows:[]};}
        continue;
      }
      let acceptedContinuation=0;
      for(let j=i+span;j<lines.length&&j<=i+span+4;j++){
        const row=lines[j];
        if(isBusinessNameStop(row.text))break;
        const cut=cutBusinessNameStop(row.text);
        if(cut.text&&isPlausibleBusinessNameChunk(cut.text)){
          parts.push(cleanBusinessNameChunk(cut.text));used.push(row);continuationRows.push(row);acceptedContinuation++;
          // Tên hộ kinh doanh thực tế thường 1-3 dòng. Không quét lang sang phần dưới giấy.
          if(acceptedContinuation>=2)break;
        }else if(parts.length){
          // Sau khi đã có tên thật, gặp một dòng rác/watermark thì dừng thay vì nuốt tiếp.
          break;
        }
        if(cut.stopped)break;
      }
      const value=canonicalStructuredBusinessName(normalize(parts.join(' ')));
      if(value.length>=3){const ev=unionEvidenceLines(used);if(ev)ev.score=Math.max(ev.confidence||0,90);return {value,line:ev,exact:true,continuationRows};}
    }
  }
  return null;
}

function normalizeBusinessNameKnownTerms(value=''){
  const words=normalize(value).split(/\s+/).filter(Boolean),out=[];
  for(let i=0;i<words.length;){
    const a=noAccent(words[i]||''),b=noAccent(words[i+1]||''),c=noAccent(words[i+2]||'');
    if(a==='ho'&&b==='kinh'&&c==='doanh'){out.push('HỘ','KINH','DOANH');i+=3;continue;}
    if(a==='quay'&&b==='thuoc'){out.push('QUẦY','THUỐC');i+=2;continue;}
    if(a==='nha'&&b==='thuoc'){out.push('NHÀ','THUỐC');i+=2;continue;}
    out.push(String(words[i]).toUpperCase());i++;
  }
  return normalize(out.join(' '));
}
function businessNameTypeInfo(value=''){
  const words=normalizeBusinessNameKnownTerms(value).split(/\s+/).filter(Boolean);
  const bases=words.map(x=>noAccent(x).replace(/[^a-z]/g,''));
  let typeIndex=-1,type='';
  for(let i=0;i<bases.length-1;i++){
    if(bases[i]==='quay'&&bases[i+1]==='thuoc'){typeIndex=i;type='QUẦY THUỐC';break;}
    if(bases[i]==='nha'&&bases[i+1]==='thuoc'){typeIndex=i;type='NHÀ THUỐC';break;}
  }
  if(typeIndex<0)return null;
  let hasHousehold=false;
  for(let i=0;i<=typeIndex-3;i++)if(bases[i]==='ho'&&bases[i+1]==='kinh'&&bases[i+2]==='doanh'){hasHousehold=true;break;}
  return {words,bases,typeIndex,type,hasHousehold};
}
function cleanProperBusinessNameWords(words=[]){
  const out=[];
  for(const raw0 of words){
    const raw=String(raw0||'').replace(/^[|:;,._\-–—]+|[|:;,._\-–—]+$/g,'').trim();if(!raw)continue;
    const base=noAccent(raw).replace(/[^a-z0-9]/g,'');if(!base)continue;
    // Tên riêng của quầy/nhà thuốc chỉ 1-3 từ. Gặp số hoặc token rác ngắn kiểu NC/TI/VN thì dừng ngay.
    if(/\d/.test(base))break;
    if(['nc','ti','vn','xx','xxx'].includes(base))break;
    if(base.length<=2&&!/[aeiouy]/.test(base))break;
    if(!/^[\p{L}Đđ'’.-]+$/u.test(raw))break;
    out.push(raw.toUpperCase());
    if(out.length>=3)break;
  }
  return out;
}
function canonicalStructuredBusinessName(value=''){
  // Cấu trúc duy nhất chấp nhận:
  // [HỘ KINH DOANH - tùy chọn] + [QUẦY THUỐC | NHÀ THUỐC] + [tên riêng 1-3 từ].
  const cleaned=normalizeBusinessNameKnownTerms(cleanBusinessNameChunk(value));
  const info=businessNameTypeInfo(cleaned);if(!info)return '';
  const proper=cleanProperBusinessNameWords(info.words.slice(info.typeIndex+2));
  if(!proper.length)return '';
  return normalize(`${info.hasHousehold?'HỘ KINH DOANH ':''}${info.type} ${proper.join(' ')}`);
}
function properBusinessNameTail(value=''){
  const info=businessNameTypeInfo(value);if(!info)return '';
  return cleanProperBusinessNameWords(info.words.slice(info.typeIndex+2)).join(' ');
}
function businessNameHead(value=''){
  const info=businessNameTypeInfo(value);if(!info)return '';
  return `${info.hasHousehold?'HỘ KINH DOANH ':''}${info.type}`.trim();
}
function cleanProperNameOnly(text=''){
  let t=normalize(text).replace(/[“”"<>^ˆ=~{}\[\]\\]/g,' ');
  // Một crop tên riêng có thể OCR kèm nhãn khác; lấy tối đa 3 từ chữ liên tiếp và dừng ở rác/số.
  const words=t.split(/\s+/).filter(Boolean),out=[];
  for(const w of words){
    const base=noAccent(w).replace(/[^a-z0-9]/g,'');if(!base)continue;
    if(/\d/.test(base)||['nc','ti','vn','xx','xxx'].includes(base))break;
    if(!/^[\p{L}Đđ'’.-]+$/u.test(w))continue;
    if(base.length<=2&&!/[aeiouy]/.test(base))break;
    out.push(w.replace(/^[|:;,._\-–—]+|[|:;,._\-–—]+$/g,'').toUpperCase());
    if(out.length>=3)break;
  }
  return normalize(out.join(' '));
}
function businessNameQuality(value=''){
  const t=normalizeBusinessNameKnownTerms(value),n=noAccent(t);if(!t)return 0;
  let q=0;
  if(n.includes('ho kinh doanh'))q+=24;
  if(n.includes('quay thuoc')||n.includes('nha thuoc'))q+=18;
  if(!/tru so|thua dat|dien thoai|fax|website|thu dien tu/.test(n))q+=20;
  const chars=[...t],letters=chars.filter(c=>/\p{L}/u.test(c)).length,bad=chars.filter(c=>!/[\p{L}\d\s&'’().,+\-/]/u.test(c)).length;
  q+=Math.min(20,Math.round(letters/Math.max(1,chars.length)*20));q-=bad*6;
  if(t.length>85)q-=20;
  return q;
}
function locateBusinessNameBand(lines,image){
  let anchor=null,stop=null;
  for(let i=0;i<lines.length&&!anchor;i++)for(let span=1;span<=3&&i+span<=lines.length;span++){
    const rows=lines.slice(i,i+span),text=rows.map(x=>x.text).join(' ');
    if(isBusinessNameAnchor(text)){const ev=unionEvidenceLines(rows);if(ev?.bbox){anchor=ev;break;}}
  }
  if(anchor?.bbox){
    const ay=anchor.bbox.y0;
    for(const row of lines){if(!row?.bbox||row.bbox.y0<=ay)continue;if(isBusinessAddressAnchorStart(row.text)){stop=row;break;}}
    const padX=Math.round(image.naturalWidth*.025),padY=Math.max(8,Math.round(image.naturalHeight*.006));
    const sx=padX,sy=Math.max(0,anchor.bbox.y0-padY),sw=image.naturalWidth-padX*2;
    let ey=stop?.bbox?.y0 ? stop.bbox.y0+Math.round(padY*.4) : anchor.bbox.y1+Math.round(image.naturalHeight*.14);
    ey=Math.min(image.naturalHeight,Math.max(anchor.bbox.y1+30,ey));
    return {sx,sy,sw,sh:Math.max(50,ey-sy)};
  }
  return {sx:Math.round(image.naturalWidth*.02),sy:Math.round(image.naturalHeight*.40),sw:Math.round(image.naturalWidth*.96),sh:Math.round(image.naturalHeight*.19)};
}
function thresholdDocumentCanvas(src){
  const c=document.createElement('canvas');c.width=src.width;c.height=src.height;const ctx=c.getContext('2d');ctx.drawImage(src,0,0);
  try{
    const im=ctx.getImageData(0,0,c.width,c.height),d=im.data,h=new Array(256).fill(0);let total=0,sum=0;
    for(let i=0;i<d.length;i+=4){const g=Math.round(.299*d[i]+.587*d[i+1]+.114*d[i+2]);h[g]++;total++;sum+=g;}
    let sumB=0,wB=0,maxV=-1,th=175;
    for(let t=0;t<256;t++){wB+=h[t];if(!wB)continue;const wF=total-wB;if(!wF)break;sumB+=t*h[t];const mB=sumB/wB,mF=(sum-sumB)/wF,v=wB*wF*(mB-mF)*(mB-mF);if(v>maxV){maxV=v;th=t;}}
    th=Math.max(125,Math.min(205,th+8));
    for(let i=0;i<d.length;i+=4){const g=.299*d[i]+.587*d[i+1]+.114*d[i+2],v=g<th?0:255;d[i]=d[i+1]=d[i+2]=v;}
    ctx.putImageData(im,0,0);
  }catch(e){}
  return c;
}
function consensusBusinessName(hits){
  const good=(hits||[]).filter(x=>x?.value).map((x,idx)=>({
    ...x,idx,value:canonicalStructuredBusinessName(x.value),base:noAccent(canonicalStructuredBusinessName(x.value)),quality:businessNameQuality(x.value)+(x.line?.confidence||65)*.25
  }));
  if(!good.length)return null;
  const groups=new Map();for(const x of good){if(!groups.has(x.base))groups.set(x.base,[]);groups.get(x.base).push(x);}
  let group=[...groups.values()].sort((a,b)=>(b.length-a.length)||((Math.max(...b.map(x=>x.quality)))-(Math.max(...a.map(x=>x.quality)))))[0];
  if(group.length===1){const x=group[0];return {...x,value:canonicalStructuredBusinessName(x.value)};}
  const tokenRows=group.map(x=>x.value.split(/\s+/));const maxLen=Math.max(...tokenRows.map(r=>r.length)),out=[];
  for(let i=0;i<maxLen;i++){
    const choices=new Map();for(let r=0;r<tokenRows.length;r++){const tok=tokenRows[r][i];if(!tok)continue;const key=tok.toUpperCase();if(!choices.has(key))choices.set(key,{tok,count:0,best:-1});const z=choices.get(key);z.count++;z.best=Math.max(z.best,group[r].quality);}
    const win=[...choices.values()].sort((a,b)=>(b.count-a.count)||(b.best-a.best))[0];if(win)out.push(win.tok);
  }
  const best=group.slice().sort((a,b)=>b.quality-a.quality)[0];const combined=canonicalStructuredBusinessName(out.join(' '));return {...best,value:combined||canonicalStructuredBusinessName(best.value),agreement:group.length};
}
function applyTargetedBusinessName(hit){
  if(!hit?.value)return;const cur=state.fields.ten_co_so;if(cur.verified)return;
  const val=canonicalStructuredBusinessName(hit.value);if(!val)return;const base=noAccent(val),curBase=noAccent(cur.value||''),q=businessNameQuality(val),curQ=businessNameQuality(cur.value||'');
  const conf=Math.max(86,Math.min(96,Math.round((hit.line?.confidence||78)+(hit.agreement>=2?10:6))));
  // ROI tên riêng được ưu tiên khi cùng chuỗi không dấu (chỉ khác dấu), hoặc chất lượng cấu trúc rõ ràng tốt hơn.
  if(!cur.value||base===curBase||q>=curQ+8){state.fields.ten_co_so={value:val,confidence:conf,evidence:evidenceOf(hit.line),verified:false};}
}
async function targetedBusinessName(job,w){
  if(!isJobCurrent(job))return;const image=job.image,doc=state.documents[job.documentType]||{},band=locateBusinessNameBand(doc.lines||[],image);
  const crop=cropImagePixels(image,band.sx,band.sy,band.sw,band.sh,3.8),variants=[crop.canvas,enhanceDocumentCanvas(crop.canvas),thresholdDocumentCanvas(crop.canvas)],hits=[];
  for(const canvas of variants){
    try{const r=await w.recognize(canvas,{}, {blocks:true});if(!isJobCurrent(job))return;const lines=mapLinesFromCrop(r,crop),hit=extractBusinessName(lines);if(hit)hits.push(hit);}catch(e){console.warn('OCR tên cơ sở GPKD:',e);}
  }
  let hit=consensusBusinessName(hits);
  // V1.2.8: nếu tên riêng nằm ở dòng kế tiếp (rất phổ biến), OCR lại CHỈ dòng tên đó ở độ phóng lớn.
  // Đây là bước sửa lỗi dấu kiểu HÃNG/HẰNG mà không cho watermark/địa chỉ chen vào.
  if(hit){
    const rowCandidates=[];
    for(const h of hits)for(const r of (h.continuationRows||[]))if(r?.bbox)rowCandidates.push(r);
    const head=businessNameHead(hit.value),tailBase=noAccent(properBusinessNameTail(hit.value));
    const micro=[];
    for(const row of rowCandidates.slice(0,3)){
      const b=row.bbox,padX=Math.max(10,Math.round((b.x1-b.x0)*.06)),padY=Math.max(7,Math.round((b.y1-b.y0)*.45));
      const mc=cropImagePixels(image,b.x0-padX,b.y0-padY,(b.x1-b.x0)+padX*2,(b.y1-b.y0)+padY*2,6.0);
      const mvars=[mc.canvas,enhanceDocumentCanvas(mc.canvas),thresholdDocumentCanvas(mc.canvas)];
      for(const mv of mvars){
        try{
          const rr=await w.recognize(mv);if(!isJobCurrent(job))return;
          const proper=cleanProperNameOnly(rr.data.text||'');
          if(proper&&noAccent(proper)===tailBase)micro.push({value:proper,confidence:Math.round(rr.data.confidence||70)});
        }catch(e){console.warn('OCR dòng tên riêng GPKD:',e);}
      }
    }
    if(micro.length){
      const groups=new Map();
      for(const m of micro){const k=m.value.toUpperCase();if(!groups.has(k))groups.set(k,{value:k,count:0,best:0,sum:0});const g=groups.get(k);g.count++;g.best=Math.max(g.best,m.confidence);g.sum+=m.confidence;}
      const win=[...groups.values()].sort((a,b)=>(b.best-a.best)||(b.count-a.count)||(b.sum-a.sum))[0];
      if(win?.value)hit={...hit,value:`${head} ${win.value}`.trim(),agreement:Math.max(hit.agreement||1,win.count)};
    }
    applyTargetedBusinessName(hit);
  }
}

function extractPTCM(lines){
  for(let i=0;i<lines.length;i++){
    const n=noAccent(lines[i].text);if(!n.includes('chung nhan'))continue;
    let text=lines[i].text;
    let tail=text.replace(/^.*?chứng\s*nhận\s*:?\s*/i,'').replace(/^.*?chung\s*nhan\s*:?\s*/i,'').trim();
    let used=[lines[i]];
    if(!tail&&lines[i+1]){tail=lines[i+1].text;used.push(lines[i+1]);}
    // Chịu được OCR "Ông/Bà", "Ong/Ba", "Ônbà", "Onba" và loại phần nhãn sinh/giới tính phía sau.
    tail=cleanPersonNameV1213(tail);
    if(validPersonNameV1213(tail))return {value:tail,line:unionEvidenceLines(used)};
  }
  return null;
}

/* V1.2.13 - ĐỐI CHIẾU NGƯỜI PTCM VỚI BẰNG TỐT NGHIỆP
   - Không thêm trường mới ra giao diện.
   - Chỉ dùng tên trên Bằng như nguồn xác minh khi CCHND đã có trong hồ sơ.
   - Nếu Người PTCM đã được người dùng sửa/xác nhận (verified) thì tuyệt đối không tự đổi.
   - Nếu hai tên khác hẳn nhau thì không đoán. */
function cleanPersonNameV1213(text=''){
  let t=normalize(text)
    .split(/\b(?:Giới\s*tính|Gioi\s*tinh|Ngày\s*sinh|Ngay\s*sinh|Sinh\s*ngày|Sinh\s*ngay|Năm\s*sinh|Nam\s*sinh|Date\s*of\s*birth|Born|Số\s*CMND|So\s*CMND|CCCD|Căn\s*cước|Can\s*cuoc)\b/i)[0]
    .trim();
  t=t.replace(/^.*?(?:Họ\s*(?:và\s*)?tên|Ho\s*(?:va\s*)?ten|Họ\s*tên|Ho\s*ten|Upon|Name|Cho)\s*[:\-]?\s*/i,'');
  t=t.replace(/^\s*(?:Ông\s*\/?\s*Bà|Ong\s*\/?\s*Ba|Ông|Ong|Bà|Ba|Mr\.?|Ms\.?|Mrs\.?)\s*[:\-]?\s*/i,'');
  // Một số OCR ghép "Ông/Bà" thành "Ônbà", "Ongba", "Onba".
  const na=noAccent(t);
  if(/^(?:ongba|onba|omba)\b/.test(na))t=t.replace(/^\S+\s*[:\-]?\s*/,'');
  t=t.replace(/[^\p{L}\s'.-]/gu,' ').replace(/\s+/g,' ').replace(/^[\s'.-]+|[\s'.-]+$/g,'').trim();
  return t;
}
function validPersonNameV1213(value=''){
  const t=cleanPersonNameV1213(value),n=noAccent(t),words=t.split(/\s+/).filter(Boolean);
  if(words.length<2||words.length>5||t.length<5||t.length>48)return false;
  const bad=['bang tot nghiep','bang duoc si','duoc si','degree','pharmacist','hieu truong','rector','truong','university','college','cao dang','dai hoc','viet nam','cong hoa','doc lap','ngay sinh','date of birth','chinh quy','full time'];
  if(bad.some(x=>n.includes(x)))return false;
  return words.every(w=>noAccent(w).replace(/[^a-z]/g,'').length>=1);
}
function hasVietnameseMarksV1213(value=''){
  const t=String(value||'');
  if(/[đĐ]/.test(t))return true;
  return t.normalize('NFD')!==t.normalize('NFD').replace(/[\u0300-\u036f]/g,'');
}
function personKeyV1213(value=''){
  return noAccent(cleanPersonNameV1213(value)).replace(/[^a-z]+/g,' ').replace(/\s+/g,' ').trim();
}
function repairNameUsingSkeletonV1213(current='',candidate=''){
  const cw=cleanPersonNameV1213(current).split(/\s+/).filter(Boolean),dw=cleanPersonNameV1213(candidate).split(/\s+/).filter(Boolean);
  if(cw.length!==dw.length||cw.length<2)return '';
  const out=[];
  for(let i=0;i<cw.length;i++){
    const c=cw[i],d=dw[i],cn=noAccent(c).replace(/[^a-z]/g,''),dn=noAccent(d).replace(/[^a-z]/g,'');
    if(!cn||!dn)return '';
    if(cn===dn){out.push(hasVietnameseMarksV1213(c)?c:d);continue;}
    if(cn.endsWith(dn)&&cn.length-dn.length<=1){const chars=[...c];out.push(chars.slice(chars.length-[...d].length).join(''));continue;}
    if(dn.endsWith(cn)&&dn.length-cn.length<=1){out.push(d);continue;}
    return '';
  }
  const value=out.join(' ');return validPersonNameV1213(value)?value:'';
}
function levenshteinV1213(a='',b=''){
  a=String(a);b=String(b);if(a===b)return 0;if(!a.length)return b.length;if(!b.length)return a.length;
  let prev=Array.from({length:b.length+1},(_,i)=>i),cur=new Array(b.length+1);
  for(let i=1;i<=a.length;i++){
    cur[0]=i;
    for(let j=1;j<=b.length;j++)cur[j]=Math.min(cur[j-1]+1,prev[j]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));
    [prev,cur]=[cur,prev];
  }
  return prev[b.length];
}
function personSimilarityV1213(a='',b=''){
  const x=personKeyV1213(a),y=personKeyV1213(b);if(!x||!y)return 0;if(x===y)return 1;
  if(x.endsWith(y)||y.endsWith(x))return .96;
  const lev=1-levenshteinV1213(x,y)/Math.max(x.length,y.length,1);
  const xa=new Set(x.split(' ')),ya=new Set(y.split(' '));let inter=0;for(const w of xa)if(ya.has(w))inter++;
  const token=inter/Math.max(xa.size,ya.size,1);
  return Math.max(lev,token*.88+lev*.12);
}
function extractDiplomaPersonNameV1213(lines=[]){
  const candidates=[];
  const push=(raw,line,bonus=0,why='')=>{
    const value=cleanPersonNameV1213(raw);if(!validPersonNameV1213(value))return;
    const markBonus=hasVietnameseMarksV1213(value)?6:0;
    const conf=Math.max(0,Math.min(99,Math.round((line?.confidence||65)+bonus+markBonus)));
    candidates.push({value,line,score:conf,why});
  };
  for(let i=0;i<lines.length;i++){
    const line=lines[i],txt=line.text||'',n=noAccent(txt);
    const anchor=/\b(ho\s*(?:va\s*)?ten|ho\s*ten|upon|name|cho)\b/.test(n);
    if(anchor){
      push(txt,line,18,'anchor');
      if(lines[i+1])push(lines[i+1].text,lines[i+1],12,'after-anchor');
    }
    if(/\b(ngay sinh|date of birth|born)\b/.test(n)){
      if(lines[i-1])push(lines[i-1].text,lines[i-1],10,'before-birth');
      const before=txt.split(/(?:Ngày\s*sinh|Ngay\s*sinh|Date\s*of\s*birth|Born)/i)[0];
      push(before,line,8,'same-before-birth');
    }
    // Mẫu bằng cũ thường có câu "Cấp Bằng ... cho:" và tên ở cuối hoặc dòng ngay dưới.
    if((n.includes('cap bang')&&n.includes(' cho'))||(n.includes('degree')&&n.includes('upon'))){
      push(txt,line,18,'degree-for');if(lines[i+1])push(lines[i+1].text,lines[i+1],12,'degree-next');
    }
  }
  if(!candidates.length)return null;
  const groups=new Map();
  for(const c of candidates){const k=personKeyV1213(c.value);if(!k)continue;if(!groups.has(k))groups.set(k,{key:k,value:c.value,count:0,best:0,sum:0,line:c.line,why:c.why});const g=groups.get(k);g.count++;g.sum+=c.score;if(c.score>g.best){g.best=c.score;g.value=c.value;g.line=c.line;g.why=c.why;}}
  const win=[...groups.values()].sort((a,b)=>(b.count-a.count)||(b.best-a.best)||(b.sum-a.sum))[0];
  if(!win)return null;
  const consensusBonus=Math.min(10,(win.count-1)*4),score=Math.min(99,win.best+consensusBonus);
  if(score<68)return null;
  return {value:normalize(win.value),confidence:score,line:win.line,agreement:win.count};
}

/* V1.2.14 - TÊN DƯỢC SĨ TRÊN BẰNG: dùng anchor \"Cho:\" -> \"Ngày sinh:\" thay vì vùng tọa độ.
   Với font thư pháp, OCR toàn trang có thể sai mạnh; vùng động này chỉ chứa đúng dòng tên. */
function extractBirthDateHintV1214(lines=[]){
  for(let i=0;i<lines.length;i++){
    const n=noAccent(lines[i]?.text||'');
    if(!/(ngay\s*(?:,?\s*thang\s*,?\s*nam\s*)?sinh|sinh\s*ngay|date\s*of\s*birth|born)/.test(n))continue;
    let date=formatDateText(lines[i].text||'');
    if(!date&&lines[i+1])date=formatDateText(lines[i+1].text||'');
    if(date&&validDate(date))return {value:date,line:lines[i]};
  }
  return null;
}
function extractDiplomaPersonNameV1214(lines=[]){
  const c=[];
  const push=(raw,line,bonus=0,why='')=>{
    let value=cleanPersonNameV1213(raw);
    // Cắt các nhãn thường dính cùng dòng trước/sau tên.
    value=value.split(/\b(?:Ngày\s*sinh|Ngay\s*sinh|Date\s*of\s*birth|Hạng\s*tốt\s*nghiệp|Hang\s*tot\s*nghiep|Ngành|Nganh)\b/i)[0].trim();
    if(!validPersonNameV1213(value))return;
    const conf=Math.max(0,Math.min(99,Math.round((line?.confidence||65)+bonus+(hasVietnameseMarksV1213(value)?6:0))));
    c.push({value,line,score:conf,why});
  };
  for(let i=0;i<lines.length;i++){
    const line=lines[i],txt=line?.text||'',n=noAccent(txt);
    // Mẫu bằng Việt Nam rất thường dùng \"Cho: HỌ TÊN\".
    if(/(?:^|\s)cho\s*[:\-]?/.test(n)){
      const m=txt.match(/(?:^|\s)Cho\s*[:\-]?\s*(.+)$/i);
      if(m?.[1])push(m[1],line,28,'cho-same-line');
      // Nếu Tesseract tách tên sang dòng sau, chỉ lấy trước anchor Ngày sinh.
      for(let j=i+1;j<=Math.min(lines.length-1,i+2);j++){
        const nn=noAccent(lines[j]?.text||'');if(/ngay\s*sinh|date\s*of\s*birth/.test(nn))break;
        push(lines[j].text,lines[j],20,'cho-next-line');
      }
    }
    if(/ngay\s*sinh|date\s*of\s*birth/.test(n)){
      if(lines[i-1])push(lines[i-1].text,lines[i-1],18,'before-birth');
      const before=txt.split(/(?:Ngày\s*sinh|Ngay\s*sinh|Date\s*of\s*birth)/i)[0];push(before,line,12,'same-before-birth');
    }
    if(/\b(ho\s*(?:va\s*)?ten|ho\s*ten|name)\b/.test(n)){
      push(txt,line,16,'name-anchor');if(lines[i+1])push(lines[i+1].text,lines[i+1],10,'name-next');
    }
  }
  if(!c.length)return extractDiplomaPersonNameV1213(lines);
  const groups=new Map();
  for(const x of c){const k=personKeyV1213(x.value);if(!k)continue;if(!groups.has(k))groups.set(k,{key:k,value:x.value,count:0,best:0,sum:0,line:x.line,why:x.why});const g=groups.get(k);g.count++;g.sum+=x.score;if(x.score>g.best){g.best=x.score;g.value=x.value;g.line=x.line;g.why=x.why;}}
  const win=[...groups.values()].sort((a,b)=>(b.count-a.count)||(b.best-a.best)||(b.sum-a.sum))[0];
  if(!win)return null;const score=Math.min(99,win.best+Math.min(10,(win.count-1)*4));
  return score>=68?{value:normalize(win.value),confidence:score,line:win.line,agreement:win.count,why:win.why}:null;
}
function locateDiplomaNameBandV1214(lines=[],image){
  if(!image)return null;
  let cho=null,birth=null,choIndex=-1;
  for(let i=0;i<lines.length;i++){
    const n=noAccent(lines[i]?.text||'');
    if(!cho&&lines[i]?.bbox&&/(?:^|\s)cho\s*[:\-]?/.test(n)){cho=lines[i];choIndex=i;continue;}
    if(cho&&lines[i]?.bbox&&i>choIndex&&/ngay\s*sinh|date\s*of\s*birth/.test(n)){birth=lines[i];break;}
  }
  if(!cho?.bbox)return null;
  const iw=image.naturalWidth||image.width,ih=image.naturalHeight||image.height;
  const px=Math.max(12,Math.round(iw*.018)),py=Math.max(8,Math.round(ih*.008));
  const sx=Math.max(0,cho.bbox.x0-px);
  const ex=Math.min(iw,Math.max(cho.bbox.x1+px,birth?.bbox?.x1||cho.bbox.x1+Math.round(iw*.20)));
  const sy=Math.max(0,cho.bbox.y0-py);
  const ey=Math.min(ih,birth?.bbox?.y0?birth.bbox.y0-Math.round(py*.2):cho.bbox.y1+Math.round(ih*.07));
  if(ey-sy<20||ex-sx<60)return null;
  return {sx,sy,sw:ex-sx,sh:ey-sy};
}
async function targetedDiplomaPersonV1214(job,w){
  if(!isJobCurrent(job)||job.documentType!=='bang')return;
  const image=job.ocrImage||job.image,doc=state.documents?.bang,band=locateDiplomaNameBandV1214(doc?.lines||[],image);if(!band)return;
  const crop=cropImagePixels(image,band.sx,band.sy,band.sw,band.sh,5.2),vars=[crop.canvas,enhanceDocumentCanvas(crop.canvas),thresholdDocumentCanvas(crop.canvas)],hits=[];
  for(const cv of vars){
    try{
      const r=await w.recognize(cv,{}, {blocks:true});if(!isJobCurrent(job))return;
      const ls=mapLinesFromCrop(r,crop),hit=extractDiplomaPersonNameV1214(ls);if(hit)hits.push(hit);
    }catch(e){console.warn('OCR tên Dược sĩ trên Bằng V1.2.14:',e);}
  }
  if(!hits.length)return;
  const groups=new Map();for(const h of hits){const k=personKeyV1213(h.value);if(!k)continue;if(!groups.has(k))groups.set(k,{value:h.value,count:0,best:0,line:h.line});const g=groups.get(k);g.count++;if(h.confidence>g.best){g.best=h.confidence;g.value=h.value;g.line=h.line;}}
  const win=[...groups.values()].sort((a,b)=>(b.count-a.count)||(b.best-a.best))[0];if(!win)return;
  doc.recognitionHints=doc.recognitionHints||{};
  const conf=Math.min(99,win.best+Math.min(10,(win.count-1)*4));
  if(conf>Number(doc.recognitionHints.personConfidence||0)){doc.recognitionHints.personName=win.value;doc.recognitionHints.personConfidence=conf;doc.recognitionHints.personAgreement=win.count;}
}
function personNameCorruptV1214(raw=''){
  const t=normalize(raw),n=noAccent(t).replace(/[^a-z\s]/g,' ').replace(/\s+/g,' ').trim();
  if(/^(onba|ongba|omba|on ba|ong ba)\b/.test(n))return true;
  if(/\d/.test(t))return true;
  if((t.match(/[^\p{L}\s'.:\/-]/gu)||[]).length>0)return true;
  const cleaned=cleanPersonNameV1213(t),words=cleaned.split(/\s+/).filter(Boolean);
  return words.length<2||words.length>5;
}

/* V1.2.16 FINAL - TÊN NGƯỜI TRÊN CCHND: ROI động theo anchor, KHÔNG tọa độ cố định.
   Bắt đầu tại "Chứng nhận" và dừng trước "Ngày sinh/Sinh ngày/Giới tính". */
function locateCCHNDPersonBandV1216(lines=[],image){
  if(!image)return null;
  let start=null,stop=null,startIndex=-1;
  for(let i=0;i<lines.length;i++){
    const n=noAccent(lines[i]?.text||'');
    if(!start&&lines[i]?.bbox&&n.includes('chung nhan')){start=lines[i];startIndex=i;continue;}
    if(start&&lines[i]?.bbox&&i>startIndex&&/(ngay\s*(?:,?\s*thang\s*,?\s*nam\s*)?sinh|sinh\s*ngay|gioi\s*tinh|so\s*(?:cmnd|cccd)|can\s*cuoc)/.test(n)){stop=lines[i];break;}
  }
  if(!start?.bbox)return null;
  const W=image.naturalWidth||image.width,H=image.naturalHeight||image.height;
  const px=Math.max(16,Math.round(W*.02)),py=Math.max(10,Math.round(H*.01));
  const sx=Math.max(0,start.bbox.x0-px);
  const ex=Math.min(W,Math.max(start.bbox.x1+Math.round(W*.48),stop?.bbox?.x1||0));
  const sy=Math.max(0,start.bbox.y0-py);
  const ey=Math.min(H,stop?.bbox?.y0?stop.bbox.y0-Math.round(py*.15):start.bbox.y1+Math.round(H*.085));
  if(ex-sx<100||ey-sy<24)return null;
  return {sx,sy,sw:ex-sx,sh:ey-sy};
}
function extractCCHNDPersonV1216(lines=[]){
  const candidates=[];
  const push=(raw,line,bonus=0)=>{
    const value=cleanPersonNameV1213(raw);if(!validPersonNameV1213(value))return;
    const conf=Math.max(0,Math.min(99,Math.round((line?.confidence||65)+bonus+(hasVietnameseMarksV1213(value)?5:0))));
    candidates.push({value,line,confidence:conf});
  };
  for(let i=0;i<lines.length;i++){
    const n=noAccent(lines[i]?.text||'');
    if(n.includes('chung nhan')){
      push(lines[i].text,lines[i],16);
      if(lines[i+1])push(lines[i+1].text,lines[i+1],12);
    }
    if(/ngay\s*(?:,?\s*thang\s*,?\s*nam\s*)?sinh|sinh\s*ngay|gioi\s*tinh/.test(n)){
      if(lines[i-1])push(lines[i-1].text,lines[i-1],10);
      const before=(lines[i].text||'').split(/(?:Ngày\s*(?:,?\s*tháng\s*,?\s*năm\s*)?sinh|Sinh\s*ngày|Gioi\s*tinh|Giới\s*tính)/i)[0];
      push(before,lines[i],8);
    }
  }
  if(!candidates.length)return null;
  const groups=new Map();
  for(const c of candidates){const k=personKeyV1213(c.value);if(!k)continue;if(!groups.has(k))groups.set(k,{value:c.value,count:0,best:0,line:c.line});const g=groups.get(k);g.count++;if(c.confidence>g.best){g.best=c.confidence;g.value=c.value;g.line=c.line;}}
  const win=[...groups.values()].sort((a,b)=>(b.count-a.count)||(b.best-a.best))[0];
  if(!win)return null;
  return {value:normalize(win.value),confidence:Math.min(99,win.best+Math.min(10,(win.count-1)*4)),line:win.line,agreement:win.count};
}
async function targetedCCHNDPersonV1216(job,w){
  if(!isJobCurrent(job)||job.documentType!=='cchnd')return;
  const image=job.ocrImage||job.image,doc=state.documents?.cchnd,band=locateCCHNDPersonBandV1216(doc?.lines||[],image);if(!band)return;
  const crop=cropImagePixels(image,band.sx,band.sy,band.sw,band.sh,4.8);
  const vars=[crop.canvas,enhanceDocumentCanvas(crop.canvas),thresholdDocumentCanvas(crop.canvas)],hits=[];
  for(const cv of vars){
    try{const r=await w.recognize(cv,{}, {blocks:true});if(!isJobCurrent(job))return;const ls=mapLinesFromCrop(r,crop),hit=extractCCHNDPersonV1216(ls);if(hit)hits.push(hit);}catch(e){console.warn('OCR tên CCHND V1.2.16:',e);}
  }
  if(!hits.length)return;
  const groups=new Map();for(const h of hits){const k=personKeyV1213(h.value);if(!k)continue;if(!groups.has(k))groups.set(k,{value:h.value,count:0,best:0,line:h.line});const g=groups.get(k);g.count++;if(h.confidence>g.best){g.best=h.confidence;g.value=h.value;g.line=h.line;}}
  const win=[...groups.values()].sort((a,b)=>(b.count-a.count)||(b.best-a.best))[0];if(!win)return;
  const conf=Math.min(99,win.best+Math.min(10,(win.count-1)*4));
  const f=state.fields.nguoi_ptcm;if(f?.verified)return;
  const current=cleanPersonNameV1213(f?.value||''),candidate=cleanPersonNameV1213(win.value);
  if(!validPersonNameV1213(candidate))return;
  if(!current||personNameCorruptV1214(f.value||'')||conf>Number(f.confidence||0)+6){
    f.value=candidate;f.confidence=Math.min(96,Math.max(82,conf));f.evidence=evidenceOf(win.line);f.verified=false;f.crossCheck='OCR vùng tên CCHND';
  }
  doc.recognitionHints=doc.recognitionHints||{};doc.recognitionHints.personName=candidate;doc.recognitionHints.personConfidence=conf;
}

function collectDocumentIdentityHintsV1214(docType,lines=[]){
  const doc=state.documents?.[docType];if(!doc)return;doc.recognitionHints=doc.recognitionHints||{};
  const dob=extractBirthDateHintV1214(lines);if(dob?.value)doc.recognitionHints.birthDate=dob.value;
  if(docType==='bang'){
    const hit=extractDiplomaPersonNameV1214(lines);if(hit&&hit.confidence>Number(doc.recognitionHints.personConfidence||0)){
      doc.recognitionHints.personName=hit.value;doc.recognitionHints.personConfidence=hit.confidence;doc.recognitionHints.personAgreement=hit.agreement||1;
    }
  }
}
function collectDiplomaPersonHintV1213(docType,lines=[]){
  if(docType!=='bang')return;const doc=state.documents?.bang;if(!doc)return;
  const hit=extractDiplomaPersonNameV1213(lines);if(!hit)return;
  doc.recognitionHints=doc.recognitionHints||{};
  // V1.2.14 không cho extractor cũ ghi đè kết quả vùng Cho -> Ngày sinh tốt hơn.
  if(hit.confidence>Number(doc.recognitionHints.personConfidence||0)){
    doc.recognitionHints.personName=hit.value;doc.recognitionHints.personConfidence=hit.confidence;doc.recognitionHints.personAgreement=hit.agreement||1;
  }
}
function applyPTCMFromDiplomaV1213(){
  const f=state.fields?.nguoi_ptcm;if(!f||f.verified)return;
  const cdoc=state.documents?.cchnd,bdoc=state.documents?.bang,h=bdoc?.recognitionHints;
  if(!cdoc||!bdoc||!h?.personName)return;
  // Chỉ đối chiếu khi CCHND đã OCR xong; tránh điền tên từ Bằng trước khi có CCHND.
  if(cdoc.ocrState!=='done')return;
  const candidate=cleanPersonNameV1213(h.personName),hc=Number(h.personConfidence||0);if(!validPersonNameV1213(candidate)||hc<72)return;
  const current=cleanPersonNameV1213(f.value||'');
  const cDob=cdoc?.recognitionHints?.birthDate||'',bDob=bdoc?.recognitionHints?.birthDate||'';
  const sameBirth=!!(cDob&&bDob&&cDob===bDob);
  // Nếu CẢ HAI giấy đều đọc được ngày sinh nhưng khác nhau: tuyệt đối không dùng Bằng sửa CCHND.
  if(cDob&&bDob&&!sameBirth)return;
  // FINAL: nếu ngày sinh CCHND và Bằng trùng hoàn toàn, tên Bằng được OCR từ vùng
  // anchor Cho -> Ngày sinh với độ tin cậy cao, thì được phép cứu tên CCHND bị OCR hỏng nặng.
  if(sameBirth&&hc>=82&&(Number(f.confidence||0)<78||personNameCorruptV1214(f.value||''))){
    f.value=candidate;f.confidence=Math.min(96,Math.max(90,hc));f.evidence=null;f.recognitionSupport=['bang','ngay_sinh'];f.crossCheck='Bằng tốt nghiệp + ngày sinh';return;
  }
  if(!current){
    if(hc>=82){f.value=candidate;f.confidence=Math.min(93,Math.max(84,hc));f.evidence=null;f.recognitionSupport=['bang'];f.crossCheck='Bằng tốt nghiệp';}
    return;
  }
  const sim=personSimilarityV1213(current,candidate),fc=Number(f.confidence||0);
  const need=fc<65?.56:fc<78?.66:fc<88?.78:.91;
  if(sim<need)return;
  // Nếu Bằng chỉ đọc được tên không dấu nhưng CCHND có dấu, dùng chuỗi không dấu của Bằng như
  // "khung xương" để bỏ ký tự rác ở CCHND mà vẫn giữ dấu tiếng Việt (VD YVÕ -> VÕ).
  let resolved=candidate;
  if(!hasVietnameseMarksV1213(candidate)&&hasVietnameseMarksV1213(current)){
    const repaired=repairNameUsingSkeletonV1213(current,candidate);if(repaired)resolved=repaired;
    else if(fc>=60)return; // không hạ chất lượng từ tên có dấu xuống tên không dấu khi chưa đủ chắc.
  }
  // Chỉ thay khi Bằng giúp làm sạch rõ rệt hoặc confidence CCHND thấp hơn.
  if(personKeyV1213(current)===personKeyV1213(resolved)&&current===resolved)return;
  if(hc+8<fc&&sim<.95)return;
  f.value=resolved;f.confidence=Math.min(96,Math.max(fc,hc,88));f.recognitionSupport=['bang'];f.crossCheck='Bằng tốt nghiệp';
}

function businessStopMatch(text=''){
  const re=/(?:\bĐiện\s*thoại\b|\bDien\s*thoai\b|\bFax\b|\bThư\s*điện\s*tử\b|\bThu\s*dien\s*tu\b|\bWebsite\b|\bNgành\s*,?\s*nghề\b|\bNganh\s*,?\s*nghe\b)/i;
  return String(text).match(re);
}
function cutBusinessStop(text=''){
  const m=businessStopMatch(text);
  // Không xóa dấu phẩy cuối dòng: dấu phẩy có thể là một phần thật của địa chỉ
  // và trước đây chính việc xóa nó làm thuật toán hiểu nhầm là đã gặp mốc dừng.
  return (m?String(text).slice(0,m.index):String(text)).trim();
}
function isBusinessAddressAnchor(text=''){
  const n=gpkdAnchorText(text);
  // Chấp nhận nhãn bị OCR hỏng phần cuối, ví dụ "TRỤ SỞ CỦA HỘ KINH BI NP".
  return n.includes('tru so cua ho kinh doanh')||n.includes('tru so cua ho kinh')||n.includes('tru so cua ho')||(n.includes('tru so')&&n.includes('kinh doanh'));
}
function isExactBusinessAddressAnchor(text=''){return isBusinessAddressAnchor(text)}
function isBusinessAddressAnchorStart(text=''){
  const n=gpkdAnchorText(text);
  return n.includes('tru so')||/^\s*2\s*[.\)]/.test(String(text));
}
function stripAfterBusinessAddressAnchor(text=''){
  let t=normalize(text).replace(/^\s*\d+\s*[.\)]\s*/,'');
  if(!isBusinessAddressAnchor(t))return '';
  const colon=Math.max(t.lastIndexOf(':'),t.lastIndexOf('：'));
  if(colon>=0)return cutBusinessStop(t.slice(colon+1));
  const n=noAccent(t);
  // Nếu OCR phá hỏng "kinh doanh", dùng mốc địa chỉ thật để bỏ phần nhãn bị lỗi.
  const addrMarks=['thua dat','so nha','duong ','ap ','khom ','thon ','to ','xa ','phuong ','thi tran '];
  let addr=-1;for(const m of addrMarks){const i=n.indexOf(m);if(i>=0&&(addr<0||i<addr))addr=i;}
  if(addr>=0)return cutBusinessStop(t.slice(addr));
  const kd=n.lastIndexOf('kinh doanh');if(kd>=0)return cutBusinessStop(t.slice(kd+'kinh doanh'.length));
  const hk=n.lastIndexOf('ho kinh');return hk>=0?cutBusinessStop(t.slice(hk+'ho kinh'.length)):'';
}
function isBusinessAddressStop(text=''){
  const n=gpkdAnchorText(text);
  return /^(?:dien thoai|fax|thu dien tu|website|nganh nghe)/.test(n)||/^\s*[3-9]\s*[.\)]/.test(text);
}
function cleanBusinessAddress(text=''){
  let t=normalize(text).replace(/^[:;,.-\s]+/,'').trim();
  t=t.replace(/\s+([,.;:])/g,'$1').replace(/([,;])(?=\S)/g,'$1 ').replace(/\s{2,}/g,' ');
  t=t.replace(/Việt\s*Nam/ig,'Việt Nam');
  return t.replace(/[\-–—|]+\s*$/,'').trim();
}
function businessAddressQuality(text=''){
  const n=noAccent(text);let q=0;
  if(/thua dat|so nha|duong|\bap\b|\bkhom\b|\bthon\b/.test(n))q+=2;
  if(/\bxa\b|\bphuong\b|thi tran/.test(n))q+=2;
  if(/\btinh\b|thanh pho/.test(n))q+=2;
  if(/viet nam/.test(n))q+=1;
  if(/dien thoai|fax|website|nganh nghe/.test(n))q-=5;
  if(/[�]/.test(text))q-=3;
  if(text.length<15)q-=3;
  return q;
}
function extractBusinessPhone(lines){
  for(let i=0;i<lines.length;i++){
    const n=noAccent(lines[i].text);if(!n.includes('dien thoai'))continue;
    const rows=[lines[i]];let text=lines[i].text;
    if(!phoneFrom(text)&&lines[i+1]&&!/fax|website|thu dien tu/i.test(noAccent(lines[i+1].text))){text+=' '+lines[i+1].text;rows.push(lines[i+1]);}
    // Ưu tiên đúng số nằm sau nhãn Điện thoại, tránh lấy Mã số hộ kinh doanh 0821...
    const after=text.replace(/^.*?(?:Điện\s*thoại|Dien\s*thoai)\s*[:：-]?\s*/i,'');
    const compact=after.replace(/[ .()\-]/g,'');
    const m=compact.match(/(?:\+84|0)\d{9}\b/); // số điện thoại VN 10 chữ số sau chuẩn hóa
    const value=m?m[0].replace(/^\+84/,'0'):phoneFrom(after);
    if(value)return {value,line:unionEvidenceLines(rows)};
  }
  return null;
}
function extractBusinessAddress(lines){
  // Mốc vẫn là "Trụ sở của hộ kinh doanh:"; tìm trên 1-2 dòng để chịu lỗi tách dòng OCR.
  for(let i=0;i<lines.length;i++){
    for(let span=1;span<=2&&i+span<=lines.length;span++){
      const anchorRows=lines.slice(i,i+span),anchorText=anchorRows.map(x=>x.text).join(' ');
      if(!isBusinessAddressAnchorStart(anchorRows[0]?.text||'')||!isBusinessAddressAnchor(anchorText))continue;
      const used=[...anchorRows],parts=[];
      const first=stripAfterBusinessAddressAnchor(anchorText);if(first)parts.push(first);
      for(let j=i+span;j<lines.length&&j<=i+span+5;j++){
        if(isBusinessAddressStop(lines[j].text))break;
        const original=normalize(lines[j].text),stop=!!businessStopMatch(original),t=cutBusinessStop(original);if(!t)break;
        parts.push(t);used.push(lines[j]);
        if(stop)break;
      }
      const addr=cleanBusinessAddress(parts.join(' '));
      if(addr.length>=8){const ev=unionEvidenceLines(used);if(ev)ev.score=Math.max(ev.confidence||0,88+Math.max(0,businessAddressQuality(addr)));return {value:addr,line:ev,quality:businessAddressQuality(addr),exact:true};}
    }
  }
  return null;
}
function profileScoreV1210(docType,lines=[]){
  const p=DOCUMENT_PROFILES_V1210[docType];if(!p)return 0;
  const all=noAccent((lines||[]).map(x=>x.text||'').join(' '));let hit=0;
  for(const group of p.anchors||[])if((group||[]).every(x=>all.includes(noAccent(x))))hit++;
  return Math.round(100*hit/Math.max(1,(p.anchors||[]).length));
}
function recognitionFacilityCandidateV1210(lines=[]){
  // Chỉ nhận cấu trúc dược rõ: QUẦY THUỐC / NHÀ THUỐC + tên riêng 1-3 từ.
  // Không dùng chuỗi này thay cho rule GPKD V1.2.8; chỉ làm bằng chứng hỗ trợ từ GPP/ĐĐKKDD.
  let bestHit=null;
  for(let i=0;i<lines.length;i++){
    for(let span=1;span<=2&&i+span<=lines.length;span++){
      const ev=unionEvidenceLines(lines.slice(i,i+span));if(!ev)continue;
      const txt=normalizeBusinessNameKnownTerms(ev.text||''),info=businessNameTypeInfo(txt);if(!info)continue;
      const proper=cleanProperBusinessNameWords(info.words.slice(info.typeIndex+2));if(!proper.length)continue;
      const value=normalize(`${info.type} ${proper.join(' ')}`),n=noAccent(ev.text||'');
      let score=Math.round(ev.confidence||60);
      if(n.includes('co so'))score+=14;
      if(n.includes('tai dia chi')||n.includes('dia chi'))score-=8;
      if(proper.length>=1&&proper.length<=3)score+=8;
      if(!bestHit||score>bestHit.score)bestHit={value,score};
    }
  }
  return bestHit;
}
function facilityKeyV1210(value=''){
  return noAccent(normalizeBusinessNameKnownTerms(value))
    .replace(/^ho kinh doanh\s+/,'')
    .replace(/[^a-z0-9]+/g,' ')
    .replace(/\s+/g,' ').trim();
}
function collectRecognitionHintsV1210(docType,lines=[]){
  const doc=state.documents?.[docType];if(!doc)return;
  const hints={profileScore:profileScoreV1210(docType,lines),facilityName:'',facilityConfidence:0};
  if(docType==='gpp'||docType==='ddkkdd'){
    const hit=recognitionFacilityCandidateV1210(lines);
    if(hit){hints.facilityName=hit.value;hints.facilityConfidence=Math.max(0,Math.min(99,Math.round(hit.score||0)));}
  }
  // Chỉ metadata/hint, không thay các trường kết quả V1.2.8.
  doc.recognitionHints=hints;
}
function applySafeRecognitionHintsV1210(){
  // Guard cực chặt: chỉ bổ sung dấu cho TÊN CƠ SỞ GPKD khi 2 giấy độc lập cùng đồng thuận.
  // Tuyệt đối không sửa Bằng, ngày, số giấy, địa chỉ, điện thoại hoặc nơi cấp.
  const f=state.fields?.ten_co_so;if(!f?.value||f.verified)return;
  const current=canonicalStructuredBusinessName(f.value);if(!current)return;
  const currentKey=facilityKeyV1210(current);if(!currentKey)return;
  const supporters=[];
  for(const dt of ['gpp','ddkkdd']){
    const h=state.documents?.[dt]?.recognitionHints,raw=h?.facilityName;if(!raw)continue;
    const candidate=canonicalStructuredBusinessName(raw)||normalize(raw);
    if(facilityKeyV1210(candidate)!==currentKey)continue;
    supporters.push({dt,value:normalize(raw),confidence:Number(h.facilityConfidence||0)});
  }
  if(supporters.length<2)return;
  const groups=new Map();
  for(const x of supporters){const k=x.value.toUpperCase();if(!groups.has(k))groups.set(k,{value:x.value,count:0,best:0,sources:[]});const g=groups.get(k);g.count++;g.best=Math.max(g.best,x.confidence);g.sources.push(x.dt);}
  const win=[...groups.values()].sort((a,b)=>(b.count-a.count)||(b.best-a.best))[0];
  if(!win||win.count<2)return;
  const hasHousehold=noAccent(current).startsWith('ho kinh doanh ');
  const candidate=canonicalStructuredBusinessName(`${hasHousehold?'HỘ KINH DOANH ':''}${win.value}`);if(!candidate)return;
  // Phải giống 100% khi bỏ dấu: nghĩa là chỉ sửa dấu, không thay chữ/từ/cấu trúc.
  if(facilityKeyV1210(candidate)!==currentKey||candidate===f.value)return;
  f.value=candidate;f.confidence=Math.max(f.confidence||0,Math.min(96,Math.max(90,win.best)));
  f.recognitionSupport=win.sources;
}

function graduationYearFromVietnameseContext(text=''){
  const n=noAccent(text).replace(/[|]/g,' ');
  // V1.2.14: vẫn chỉ nhận ngữ cảnh tiếng Việt, nhưng chịu được OCR dính chữ-số như
  // "ngày27 tháng06 năm2022" / "ngay 27 thang 06 nam2022".
  // Không fallback sang một năm bất kỳ trên giấy.
  const m=n.match(/(?:^|[^a-z])ngay\s*[:\-]?\s*\d{1,2}[\s\S]{0,90}?nam\s*[:\-]?\s*((?:19|20)\d{2})\b/i);
  return m?m[1]:'';
}
function findGraduationYearBottomRight(lines,image=null){
  const candidates=[];
  for(let i=0;i<lines.length;i++){
    for(let span=1;span<=3&&i+span<=lines.length;span++){
      const rows=lines.slice(i,i+span),ev=unionEvidenceLines(rows);if(!ev)continue;
      const n=noAccent(ev.text);if(/ngay sinh|nam sinh|date of birth/.test(n))continue;
      const year=graduationYearFromVietnameseContext(ev.text);if(!year)continue;
      const y=linePosition(ev,i,lines.length,image),x=lineXPosition(ev,image);
      let score=(ev.confidence||60)*.30+y*42+x*18+28;
      if(y>=.48)score+=14;if(x>=.38)score+=7;if(/\bthang\b/.test(n))score+=6;if(/hieu truong|ky|ngay/.test(n))score+=4;
      candidates.push({...ev,year,score,pos:y,xpos:x});
    }
  }
  candidates.sort((a,b)=>b.score-a.score);return candidates[0]||null;
}
const SCHOOL_PROFILES_V1216 = [
  {vi:'TRƯỜNG ĐẠI HỌC QUỐC TẾ HỒNG BÀNG',viAliases:['truong dai hoc quoc te hong bang'],enAliases:['hong bang international university','hongbang international university']},
  {vi:'TRƯỜNG CAO ĐẲNG Y TẾ TIỀN GIANG',viAliases:['truong cao dang y te tien giang'],enAliases:['tien giang medical college']},
  {vi:'TRƯỜNG ĐẠI HỌC TÂY ĐÔ',viAliases:['truong dai hoc tay do'],enAliases:['tay do university']}
];
function schoolCompactV1216(text=''){return noAccent(text).replace(/[^a-z0-9]+/g,'');}
function schoolProfileFromTextV1216(text='',allowEnglish=false){
  const compact=schoolCompactV1216(text);if(!compact)return null;
  for(const p of SCHOOL_PROFILES_V1216){
    const aliases=[...(p.viAliases||[]),...(allowEnglish?(p.enAliases||[]):[])];
    for(const a of aliases){const k=schoolCompactV1216(a);if(k&&compact.includes(k))return p;}
  }
  return null;
}
function normalizeSchoolName(text=''){
  let t=normalize(text).replace(/^[|:;,\.\-\s]+|[|:;,\.\-\s]+$/g,'');
  const p=schoolProfileFromTextV1216(t,true);if(p)return p.vi;
  t=t.replace(/TRUONG/ig,'TRƯỜNG').replace(/CAO\s+DANG/ig,'CAO ĐẲNG').replace(/DAI\s+HOC/ig,'ĐẠI HỌC').replace(/TRUNG\s+CAP/ig,'TRUNG CẤP').replace(/Y\s+TE/ig,'Y TẾ');
  return t.toUpperCase();
}
function extractVietnameseSchool(lines){
  // FINAL: quét TOÀN BỘ OCR. Pass 1 chỉ nhận tiếng Việt. Pass 2 mới dùng alias tiếng Anh.
  // Tiếng Anh chỉ là tín hiệu xác định profile; dữ liệu ghi ra luôn là tên tiếng Việt chuẩn.
  let bestHit=null;
  for(let i=0;i<lines.length;i++){
    for(let span=1;span<=4&&i+span<=lines.length;span++){
      const ev=unionEvidenceLines(lines.slice(i,i+span));if(!ev)continue;
      const n=noAccent(ev.text),idx=n.indexOf('truong');if(idx<0)continue;
      const tailN=n.slice(idx);
      if(!/(truong[\s\S]{0,100}(dai hoc|cao dang|trung cap|hoc vien))/.test(tailN))continue;
      let raw=ev.text.slice(Math.max(0,idx)).replace(/^[|:;,.\-\s]+/,'').trim();
      const p=schoolProfileFromTextV1216(raw,false),value=p?.vi||normalizeSchoolName(raw);
      if(!/^(TRƯỜNG|HỌC VIỆN)/.test(value))continue;
      const score=(ev.confidence||60)+(span===1?12:5)+(p?12:0)-i*.03;
      if(!bestHit||score>bestHit.score)bestHit={value,line:{...ev,score},score,source:'vi'};
    }
  }
  if(bestHit)return bestHit;
  // Fallback tiếng Anh: bỏ khoảng trắng/gạch nối để HONGBANG = HONG BANG = HONG-BANG.
  for(let i=0;i<lines.length;i++){
    for(let span=1;span<=4&&i+span<=lines.length;span++){
      const ev=unionEvidenceLines(lines.slice(i,i+span));if(!ev)continue;
      const p=schoolProfileFromTextV1216(ev.text,true);if(!p)continue;
      // Bắt buộc alias tiếng Anh thật sự; nếu là tiếng Việt thì pass 1 đã xử lý.
      const key=schoolCompactV1216(ev.text),en=(p.enAliases||[]).some(a=>key.includes(schoolCompactV1216(a)));if(!en)continue;
      const score=(ev.confidence||60)+10-i*.02;
      if(!bestHit||score>bestHit.score)bestHit={value:p.vi,line:{...ev,score},score,source:'en-fallback'};
    }
  }
  return bestHit;
}

function extract(docType,lines,image=null){
  const all=lines.map(x=>x.text).join(' \n ');
  if(docType==='cchnd'){
    const cands=findNearby(lines,['số hiệu','so hieu','cchn','chứng chỉ hành nghề','chung chi hanh nghe'],3).filter(x=>!/(cmnd|cccd|can cuoc)/i.test(noAccent(x.text)));
    let win=best(cands.length?cands:lines,{include:['cchn','số hiệu'],exclude:['cmnd','cccd','căn cước'],top:true,pattern:/\//});
    const num=(cands.map(x=>numberFrom(x.text,'cchnd')).find(Boolean))||numberFrom(win?.text||'','cchnd');setField('so_cchnd',num,win,10);
    const sig=findSignatureDate(lines,{exclude:['cmnd','cccd','căn cước','ngày sinh','ngay sinh'],image});
    if(sig)setField('ngay_cap_cchnd',sig.date,sig,12);
    const issuer=extractIssuer(lines);if(issuer)setField('noi_cap_cchnd',issuer.value,issuer.line,14);
    const ptcm=extractPTCM(lines);if(ptcm)setField('nguoi_ptcm',ptcm.value,ptcm.line,10);
  }
  if(docType==='gpkd'){
    // V1.2.3: tên hộ kinh doanh có thể xuống 2-3 dòng (VD: QUẦY THUỐC / PHƯƠNG HẰNG).
    const businessName=extractBusinessName(lines);const name=businessName?.value||'';const nwin=businessName?.line||null;
    if(name)setField('ten_co_so',name,nwin,8);
    const na=noAccent(name||all);if(na.includes('nha thuoc'))setField('loai_co_so','Nhà thuốc',nwin,15);else if(na.includes('quay thuoc'))setField('loai_co_so','Quầy thuốc',nwin,15);
    const phoneHit=extractBusinessPhone(lines);if(phoneHit)setField('dien_thoai',phoneHit.value,phoneHit.line,10);
    const address=extractBusinessAddress(lines);if(address)setField('dia_chi',address.value,address.line,10);
  }
  if(docType==='bang'){
    const school=extractVietnameseSchool(lines);if(school)setField('truong_tot_nghiep',school.value,school.line,4);
    const sig=findGraduationYearBottomRight(lines,image);if(sig)setField('nam_cap_bang',sig.year,sig,6);
  }
  if(docType==='ddkkdd'){
    const topCount=Math.max(6,Math.ceil(lines.length*.38));const top=lines.slice(0,topCount);
    const cands=findNearby(top,['số hiệu','so hieu','số:','so:','đủ điều kiện kinh doanh dược','du dieu kien kinh doanh duoc'],3).filter(x=>!/(cchn|hanh nghe)/i.test(noAccent(x.text)));
    let win=best(cands.length?cands:top,{include:['đkkdd','ddkkdd','dkkdd','số','so'],exclude:['cchn','hành nghề','hanh nghe'],top:true,pattern:/\//});const num=cands.map(x=>numberFrom(x.text,'ddkkdd')).find(Boolean)||numberFrom(win?.text||'','ddkkdd');setField('so_ddkkdd',num,win,12);
    const sig=findSignatureDate(lines,{exclude:['cchn','hành nghề','hanh nghe','thay thế','thay the'],image});if(sig)setField('ngay_cap_ddkkdd',sig.date,sig,12);
  }
  if(docType==='gpp'){
    // V1.2.15: không giới hạn 40% đầu. Tìm Số GPP bằng anchor nội dung trên TOÀN giấy,
    // chịu OCR tách dòng/khoảng trắng và vẫn giữ bằng chứng đúng vị trí.
    const ghit=extractGPPNumberV1215(lines);if(ghit)setField('so_gpp',ghit.value,ghit.line,10);
    // Fallback rule cũ chỉ dùng khi anchor mới chưa có kết quả.
    if(!state.fields.so_gpp.value){
      const top=lines.slice(0,Math.max(6,Math.ceil(lines.length*.4)));const cands=findNearby(top,['gpp','thực hành tốt','thuc hanh tot','số:','so:'],3);let win=best(cands.length?cands:top,{include:['gpp','số','so'],top:true,pattern:/\//});const num=cands.map(x=>numberFrom(x.text,'gpp')).find(Boolean)||numberFrom(win?.text||'','gpp');setField('so_gpp',num,win,12);
    }
    const sig=findSignatureDate(lines,{exclude:['ba năm','3 năm','gia hạn','gia han'],image});if(sig)setField('ngay_cap_gpp',sig.date,sig,12);
  }
}

async function getWorker(){
  if(worker)return worker;if(!window.Tesseract)throw new Error('Không tải được Tesseract.js. Kiểm tra Internet ở lần chạy đầu.');
  $('#ocrStatus').textContent='Đang nạp OCR tiếng Việt lần đầu...';
  worker=await Tesseract.createWorker('vie',1,{logger:handleOCRProgressLogger});return worker;
}
function isJobCurrent(job){
  return !!job&&state.id===job.recordId&&state.documents[job.documentType]?.revision===job.revision;
}
function enqueueOCR(job){ocrQueue.push(job);drainOCRQueue();}
async function drainOCRQueue(){
  if(ocrQueueRunning)return;ocrQueueRunning=true;
  try{while(ocrQueue.length){const job=ocrQueue.shift();if(!isJobCurrent(job)){if(job?.objectUrl)URL.revokeObjectURL(job.objectUrl);continue;}await runOCRJob(job);}}finally{ocrQueueRunning=false;}
}
async function processImage(docType,file){
  activeDoc=docType;clearDocumentFields(docType);previewZoom=1;currentEvidence=null;
  const previousRevision=Number(state.documents[docType]?.revision||0);const revision=previousRevision+1;
  // Giữ blob URL sống trong SUỐT job OCR. Tesseract.js có thể cần fetch lại src của HTMLImageElement.
  // Không revoke ngay sau load như V1.2.1 vì khi chạy trực tiếp file:// sẽ gây "Failed to fetch".
  const url=URL.createObjectURL(file);let image;
  try{image=await loadImage(url);}catch(e){URL.revokeObjectURL(url);throw e;}
  activeImage=image;drawPreview(activeImage,null);
  state.documents[docType]={name:file.name||`${docType}.jpg`,blob:file,ocrText:'',updatedAt:new Date().toISOString(),revision,ocrState:'queued',ocrProgress:2,ocrStage:'Chờ OCR'};
  const job={id:crypto.randomUUID(),recordId:state.id,documentType:docType,revision,image,objectUrl:url,fileName:file.name||`${docType}.jpg`};
  renderDocuments();renderFields();
  $('#ocrStatus').textContent=`Đã xếp hàng OCR: ${DOCS[docType].name}.`;
  enqueueOCR(job);
}
async function runOCRJob(job){
  if(!isJobCurrent(job))return;const docType=job.documentType;let image=job.image;
  activeOCRProgressDocType=docType;
  state.documents[docType].ocrState='running';setDocumentOCRProgress(docType,5,'Khởi động OCR');renderDocuments();
  $('#ocrStatus').textContent=`Đang OCR: ${DOCS[docType].name}...`;
  try{
    const w=await getWorker();if(!isJobCurrent(job))return;
    setDocumentOCRProgress(docType,12,'OCR toàn trang');
    let result=await w.recognize(image,{}, {blocks:true});if(!isJobCurrent(job))return;
    const oriented=await chooseOCROrientationV1211(job,w,result);if(!isJobCurrent(job))return;
    setDocumentOCRProgress(docType,72,'Đã xác định hướng');
    image=oriented.image;result=oriented.result;job.ocrImage=image;job.ocrRotation=oriented.rotation||0;
    state.documents[docType].ocrRotation=job.ocrRotation;
    if(job.ocrRotation&&activeDoc===docType){activeImage=image;drawPreview(activeImage,null);}
    const lines=lineObjects(result);state.documents[docType].ocrText=result.data.text||'';state.documents[docType].lines=lines;
    extract(docType,lines,image);setDocumentOCRProgress(docType,78,'Đang tách dữ liệu');if(!isJobCurrent(job))return;
    if(docType==='bang'){
      await targetedGraduationYear(job,w);if(!isJobCurrent(job))return;
      try{collectDocumentIdentityHintsV1214(docType,lines);await targetedDiplomaPersonV1214(job,w);}catch(e){console.warn('Tên trên Bằng V1.2.16:',e);}
    }else if(docType==='cchnd'){
      try{collectDocumentIdentityHintsV1214(docType,lines);await targetedCCHNDPersonV1216(job,w);}catch(e){console.warn('Tên CCHND V1.2.16:',e);}
    }else{
      try{collectDocumentIdentityHintsV1214(docType,lines);}catch(e){console.warn('Dữ kiện đối chiếu V1.2.16:',e);}
    }
    if(!isJobCurrent(job))return;
    setDocumentOCRProgress(docType,85,'Đang xác minh trường');
    await targetedSupportFields(job,w);if(!isJobCurrent(job))return;
    setDocumentOCRProgress(docType,92,'Đang kiểm tra lại');
    await secondPassCritical(job,w);if(!isJobCurrent(job))return;
    setDocumentOCRProgress(docType,97,'Đang hoàn tất');
    // V1.2.10: lớp nhận diện bổ sung chạy SAU TOÀN BỘ V1.2.8; lỗi ở đây không được ảnh hưởng OCR gốc.
    try{collectRecognitionHintsV1210(docType,lines);applySafeRecognitionHintsV1210();}catch(e){console.warn('Nhận diện bổ sung V1.2.10:',e);}
    // V1.2.14: giữ extractor cũ làm fallback; không được ghi đè vùng tên động tốt hơn.
    try{collectDiplomaPersonHintV1213(docType,lines);}catch(e){console.warn('Nhận tên trên Bằng V1.2.13:',e);}
    state.documents[docType].ocrState='done';state.documents[docType].ocrProgress=100;state.documents[docType].ocrStage='Hoàn tất';state.documents[docType].updatedAt=new Date().toISOString();
    try{applyPTCMFromDiplomaV1213();}catch(e){console.warn('Đối chiếu Người PTCM V1.2.13:',e);}
    renderFields();renderDocuments();$('#ocrStatus').textContent=`Hoàn tất OCR ${DOCS[docType].name}. Có thể sửa trực tiếp nếu nhận dạng chưa đúng.`;toast(`OCR hoàn tất: ${DOCS[docType].name}.`);
  }catch(e){console.error(e);if(isJobCurrent(job)){state.documents[docType].ocrState='error';state.documents[docType].ocrStage='Lỗi OCR';renderDocuments();$('#ocrStatus').textContent='Lỗi OCR: '+e.message;toast('Không OCR được ảnh. Bạn vẫn có thể nhập trực tiếp các ô dữ liệu.');}}
  finally{if(activeOCRProgressDocType===docType)activeOCRProgressDocType=null;if(job.objectUrl){URL.revokeObjectURL(job.objectUrl);job.objectUrl=null;}for(const u of (job.tempObjectUrls||[])){try{URL.revokeObjectURL(u);}catch(e){}}job.tempObjectUrls=[];}
}
function cropImage(image,rx,ry,rw,rh,scale=2.1){
  const sx=Math.round(image.naturalWidth*rx),sy=Math.round(image.naturalHeight*ry),sw=Math.round(image.naturalWidth*rw),sh=Math.round(image.naturalHeight*rh);
  const c=document.createElement('canvas');c.width=Math.max(500,Math.round(sw*scale));c.height=Math.max(180,Math.round(sh*scale));c.getContext('2d').drawImage(image,sx,sy,sw,sh,0,0,c.width,c.height);
  return {canvas:c,sx,sy,sw,sh,scale};
}
function cropImagePixels(image,sx,sy,sw,sh,scale=2.6){
  sx=Math.max(0,Math.round(sx));sy=Math.max(0,Math.round(sy));sw=Math.max(1,Math.min(Math.round(sw),image.naturalWidth-sx));sh=Math.max(1,Math.min(Math.round(sh),image.naturalHeight-sy));
  const c=document.createElement('canvas');c.width=Math.max(500,Math.round(sw*scale));c.height=Math.max(160,Math.round(sh*scale));c.getContext('2d').drawImage(image,sx,sy,sw,sh,0,0,c.width,c.height);
  return {canvas:c,sx,sy,sw,sh,scale};
}
function enhanceDocumentCanvas(src){
  const c=document.createElement('canvas');c.width=src.width;c.height=src.height;const ctx=c.getContext('2d');ctx.drawImage(src,0,0);
  try{
    const im=ctx.getImageData(0,0,c.width,c.height),d=im.data;
    for(let i=0;i<d.length;i+=4){const g=.299*d[i]+.587*d[i+1]+.114*d[i+2];let v=(g-128)*1.38+128;v=Math.max(0,Math.min(255,v));d[i]=d[i+1]=d[i+2]=v;}
    ctx.putImageData(im,0,0);
  }catch(e){}
  return c;
}
function firstLineWith(lines,predicate){return (lines||[]).find(l=>l?.bbox&&predicate(l.text))||null;}
function mapLinesFromCrop(result,crop){return lineObjects(result).map(l=>{if(l.bbox)l.bbox={x0:crop.sx+l.bbox.x0/crop.scale,y0:crop.sy+l.bbox.y0/crop.scale,x1:crop.sx+l.bbox.x1/crop.scale,y1:crop.sy+l.bbox.y1/crop.scale};return l;});}
async function targetedGraduationYear(job,w){
  if(!isJobCurrent(job))return;const image=job.ocrImage||job.image;
  // ROI: nửa dưới, thiên phải. Quan trọng hơn vị trí là bắt buộc có "ngày ... năm 20xx" tiếng Việt.
  const crop=cropImage(image,.24,.44,.76,.54,2.2);
  try{
    const r=await w.recognize(crop.canvas,{}, {blocks:true});if(!isJobCurrent(job))return;
    const raw=mapLinesFromCrop(r,crop),hit=findGraduationYearBottomRight(raw,image);
    if(hit){const current=state.fields.nam_cap_bang;if(!current.verified&&(!current.value||hit.score>=current.confidence-8))setField('nam_cap_bang',hit.year,hit,8);}
  }catch(e){console.warn('OCR ROI năm bằng:',e);}
}
async function targetedGPPNumberV1215(job,w){
  if(!isJobCurrent(job))return;const image=job.ocrImage||job.image;
  const baseLines=state.documents.gpp?.lines||[];
  const anchor=findGPPNumberAnchorV1215(baseLines);if(!anchor?.bbox)return;
  const b=anchor.bbox,W=image.naturalWidth,H=image.naturalHeight,h=Math.max(18,b.y1-b.y0);
  // ROI động theo anchor, KHÔNG dùng tỷ lệ vị trí cố định của biểu mẫu.
  // Nếu anchor là tiêu đề GPP, mở rộng cả trên/dưới; nếu là "Số:" thì tập trung cùng dòng và vài dòng lân cận.
  let sx=0,sy,sw=W,sh;
  if(anchor.gppTitleFallback){sy=Math.max(0,b.y0-h*7);sh=Math.min(H-sy,h*14);}
  else{sy=Math.max(0,b.y0-h*2.2);sh=Math.min(H-sy,h*5.4);}
  const crop=cropImagePixels(image,sx,sy,sw,sh,3.0);
  const variants=[crop.canvas,enhanceDocumentCanvas(crop.canvas)];
  for(const canvas of variants){
    try{
      const r=await w.recognize(canvas,{}, {blocks:true});if(!isJobCurrent(job))return;
      const lines=mapLinesFromCrop(r,crop),hit=extractGPPNumberV1215(lines);
      if(hit){setField('so_gpp',hit.value,hit.line,12);if(state.fields.so_gpp.value)return;}
    }catch(e){console.warn('OCR động Số GPP V1.2.15:',e);}
  }
}
async function targetedSupportFields(job,w){
  if(!isJobCurrent(job))return;const image=job.ocrImage||job.image,docType=job.documentType;
  try{
    if(docType==='cchnd'){
      // V1.2.3: chỉ OCR vùng góc trên trái; UBND + tỉnh => SỞ Y TẾ + tỉnh.
      const crop=cropImage(image,0,0,.62,.29,2.35),r=await w.recognize(crop.canvas,{}, {blocks:true});if(!isJobCurrent(job))return;
      const lines=mapLinesFromCrop(r,crop),issuer=extractIssuer(lines);if(issuer&&!state.fields.noi_cap_cchnd.verified)setField('noi_cap_cchnd',issuer.value,issuer.line,10);
    }
    if(docType==='gpp'&&(!state.fields.so_gpp.value||state.fields.so_gpp.confidence<90)){
      await targetedGPPNumberV1215(job,w);if(!isJobCurrent(job))return;
    }
    if(docType==='gpkd'){
      // V1.2.6: GPKD có biên trường cứng; không cho tên lấn sang địa chỉ.
      // Nếu một trong các trường GPKD còn thiếu, luôn OCR vùng lõi mục 1-2-Điện thoại.
      const needCore=!state.fields.ten_co_so.value||!state.fields.dia_chi.value||!state.fields.dien_thoai.value;
      if(needCore){
        const crop=cropImage(image,.015,.39,.97,.35,2.9),enh=enhanceDocumentCanvas(crop.canvas);
        const r=await w.recognize(enh,{}, {blocks:true});if(!isJobCurrent(job))return;
        const lines=mapLinesFromCrop(r,crop);
        const businessName=extractBusinessName(lines);
        if(businessName){
          setField('ten_co_so',businessName.value,businessName.line,8);
          const n=noAccent(businessName.value);
          if(n.includes('nha thuoc'))setField('loai_co_so','Nhà thuốc',businessName.line,10);
          else if(n.includes('quay thuoc'))setField('loai_co_so','Quầy thuốc',businessName.line,10);
        }
        const address=extractBusinessAddress(lines);if(address)setField('dia_chi',address.value,address.line,8);
        const phoneHit=extractBusinessPhone(lines);if(phoneHit)setField('dien_thoai',phoneHit.value,phoneHit.line,8);
      }
      // Địa chỉ vẫn giữ cơ chế V1.2.6 đang đúng.
      if(!state.fields.dia_chi.value){
        const crop=cropImage(image,.02,.50,.96,.18,3.1),enh=enhanceDocumentCanvas(crop.canvas);
        const r=await w.recognize(enh,{}, {blocks:true});if(!isJobCurrent(job))return;
        const lines=mapLinesFromCrop(r,crop),hit=extractBusinessAddress(lines);if(hit)setField('dia_chi',hit.value,hit.line,8);
      }
      // V1.2.8: tên cơ sở LUÔN được xác minh lại bằng cấu trúc HỘ KINH DOANH? + QUẦY/NHÀ THUỐC + 1-3 từ tên riêng.
      // Ba cách tiền xử lý nhỏ bỏ watermark tốt hơn và bỏ lỗi "có chữ là coi như xong".
      await targetedBusinessName(job,w);if(!isJobCurrent(job))return;
      const finalName=state.fields.ten_co_so.value,fn=noAccent(finalName||'');
      if(fn.includes('nha thuoc'))setField('loai_co_so','Nhà thuốc',state.fields.ten_co_so.evidence||null,10);
      else if(fn.includes('quay thuoc'))setField('loai_co_so','Quầy thuốc',state.fields.ten_co_so.evidence||null,10);
    }  }catch(e){console.warn('OCR ROI hỗ trợ:',e);}
}
async function secondPassCritical(job,w){
  const docType=job.documentType,image=job.ocrImage||job.image;
  const critical={cchnd:['so_cchnd','ngay_cap_cchnd'],gpkd:['dien_thoai'],bang:['nam_cap_bang'],ddkkdd:['so_ddkkdd','ngay_cap_ddkkdd'],gpp:['so_gpp','ngay_cap_gpp']}[docType]||[];
  for(const key of critical){
    if(!isJobCurrent(job))return;const f=state.fields[key];if(!f.value||!f.evidence?.bbox)continue;const b=f.evidence.bbox,pad=28;
    const sx=Math.max(0,b.x0-pad),sy=Math.max(0,b.y0-pad),sw=Math.min(image.naturalWidth-sx,(b.x1-b.x0)+pad*2),sh=Math.min(image.naturalHeight-sy,(b.y1-b.y0)+pad*2);if(sw<20||sh<10)continue;
    const c=document.createElement('canvas');c.width=Math.max(600,Math.round(sw*2.4));c.height=Math.max(120,Math.round(sh*2.4));c.getContext('2d').drawImage(image,sx,sy,sw,sh,0,0,c.width,c.height);
    try{
      const r=await w.recognize(c);if(!isJobCurrent(job))return;const txt=normalize(r.data.text||'');let v='';
      if(key==='so_cchnd')v=numberFrom(txt,'cchnd');if(key==='so_ddkkdd')v=numberFrom(txt,'ddkkdd');if(key==='so_gpp')v=numberFrom(txt,'gpp');if(key==='dien_thoai')v=phoneFrom(txt);
      if(key==='nam_cap_bang')v=graduationYearFromVietnameseContext(txt); // tuyệt đối không fallback sang "bất kỳ năm nào"
      if(['ngay_cap_cchnd','ngay_cap_ddkkdd','ngay_cap_gpp'].includes(key)){const d=formatDateText(txt);v=validDate(d)?d:'';}
      if(v&&noAccent(v)===noAccent(f.value))f.confidence=Math.min(97,f.confidence+6);else if(v&&f.confidence<78&&!f.verified){f.value=v;f.confidence=Math.min(86,Math.max(f.confidence,72));}
    }catch(e){}
  }
}

function loadImage(url){return new Promise((res,rej)=>{const i=new Image();i.onload=()=>res(i);i.onerror=rej;i.src=url})}
function drawPreview(img,bbox){
  const c=$('#previewCanvas'),empty=$('#previewEmpty'),wrap=$('#previewWrap');currentEvidence=bbox||null;
  if(!img){c.width=1;c.height=1;c.style.width='1px';c.style.height='1px';empty.style.display='flex';updateZoomLabel();return;}
  empty.style.display='none';
  const availW=Math.max(250,(wrap.clientWidth||800)-24),availH=Math.max(220,(wrap.clientHeight||600)-24);
  let fit=Math.min(availW/img.naturalWidth,availH/img.naturalHeight);fit=Math.min(1.2,Math.max(.05,fit));
  let scale=fit*previewZoom;scale=Math.min(scale,6000/img.naturalWidth,6000/img.naturalHeight);scale=Math.max(.03,scale);lastPreviewScale=scale;
  c.width=Math.max(1,Math.round(img.naturalWidth*scale));c.height=Math.max(1,Math.round(img.naturalHeight*scale));c.style.width=c.width+'px';c.style.height=c.height+'px';
  const x=c.getContext('2d');x.drawImage(img,0,0,c.width,c.height);
  if(bbox){x.strokeStyle='#ef4444';x.lineWidth=Math.max(2,4*scale);x.fillStyle='rgba(239,68,68,.13)';const bx=bbox.x0*scale,by=bbox.y0*scale,bw=(bbox.x1-bbox.x0)*scale,bh=(bbox.y1-bbox.y0)*scale;x.fillRect(bx,by,bw,bh);x.strokeRect(bx,by,bw,bh);}
  updateZoomLabel();
}
function updateZoomLabel(){if($('#btnZoomFit'))$('#btnZoomFit').textContent=Math.round(previewZoom*100)+'%';}
function setPreviewZoom(next,focusPoint=null){
  if(!activeImage)return;const wrap=$('#previewWrap');const old=previewZoom;const oldW=$('#previewCanvas').width||1,oldH=$('#previewCanvas').height||1;
  previewZoom=Math.max(.35,Math.min(5,next));
  const px=focusPoint?.x??(wrap.scrollLeft+wrap.clientWidth/2),py=focusPoint?.y??(wrap.scrollTop+wrap.clientHeight/2);
  const rx=px/oldW,ry=py/oldH;drawPreview(activeImage,currentEvidence);
  requestAnimationFrame(()=>{wrap.scrollLeft=Math.max(0,rx*$('#previewCanvas').width-wrap.clientWidth/2);wrap.scrollTop=Math.max(0,ry*$('#previewCanvas').height-wrap.clientHeight/2);});
}
function focusEvidence(bbox){
  if(!bbox||!activeImage)return;drawPreview(activeImage,bbox);const wrap=$('#previewWrap');requestAnimationFrame(()=>{const cx=((bbox.x0+bbox.x1)/2)*lastPreviewScale,cy=((bbox.y0+bbox.y1)/2)*lastPreviewScale;wrap.scrollLeft=Math.max(0,cx-wrap.clientWidth/2);wrap.scrollTop=Math.max(0,cy-wrap.clientHeight/2);});
}

function isSupportedDropFile(file){
  if(!file)return false;
  if(/^image\/(?:jpeg|png|webp)$/i.test(file.type||''))return true;
  return /\.(?:jpe?g|png|webp)$/i.test(file.name||'');
}
function bindDocumentDrop(div,docType){
  let depth=0;
  div.addEventListener('dragenter',e=>{if(!e.dataTransfer?.types?.includes('Files'))return;e.preventDefault();depth++;div.classList.add('drop-target');});
  div.addEventListener('dragover',e=>{if(!e.dataTransfer?.types?.includes('Files'))return;e.preventDefault();e.dataTransfer.dropEffect='copy';div.classList.add('drop-target');});
  div.addEventListener('dragleave',e=>{if(!e.dataTransfer?.types?.includes('Files'))return;depth=Math.max(0,depth-1);if(!depth)div.classList.remove('drop-target');});
  div.addEventListener('drop',e=>{
    e.preventDefault();depth=0;div.classList.remove('drop-target');
    const files=[...(e.dataTransfer?.files||[])],file=files.find(isSupportedDropFile);
    if(!file){toast('Chỉ hỗ trợ kéo thả ảnh JPG, PNG hoặc WEBP.');return;}
    processImage(docType,file);
  });
}
function renderDocuments(){
  const el=$('#documents');el.innerHTML='';
  Object.entries(DOCS).forEach(([k,d])=>{
    const exists=!!state.documents[k],doc=state.documents[k],progress=documentOCRProgress(doc);const div=document.createElement('div');div.className='doc-card '+(activeDoc===k?'active':'');div.dataset.dropDoc=k;
    div.innerHTML=`<div class="doc-head"><div class="doc-name">${esc(d.name)}</div><div class="doc-status">${esc(documentOCRStatus(doc))}</div></div><div class="doc-actions"><button class="btn small primary" data-cam="${k}">Chụp</button><button class="btn small secondary" data-up="${k}">Upload</button>${exists?`<button class="btn small secondary" data-view="${k}">Xem</button><button class="btn small danger" data-remove="${k}">Xóa ảnh</button>`:'<span></span><span></span>'}</div><div class="doc-progress-track" data-state="${esc(doc?.ocrState||'empty')}" role="progressbar" aria-label="Tiến trình OCR ${esc(d.name)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><div class="doc-progress-fill" style="width:${progress}%"></div></div><div class="doc-drop-hint">Kéo thả ảnh vào đúng ô giấy này</div>`;
    bindDocumentDrop(div,k);el.appendChild(div);
  });
  $('#docProgress').textContent=`${Object.keys(state.documents).length}/5 giấy`;
  el.querySelectorAll('[data-cam]').forEach(b=>b.onclick=()=>{const k=b.dataset.cam;if(isMobileCaptureEnvironment())openMobileCameraForSingleDoc(k);else{pendingDoc=k;$('#cameraInput').click();}});
  el.querySelectorAll('[data-up]').forEach(b=>b.onclick=()=>{pendingDoc=b.dataset.up;$('#uploadInput').click()});
  el.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>viewDocument(b.dataset.view));
  el.querySelectorAll('[data-remove]').forEach(b=>b.onclick=()=>removeDocument(b.dataset.remove));
}
async function removeDocument(k){
  if(!state.documents[k])return;
  if(!confirm(`Xóa ảnh ${DOCS[k].name} và làm trống các trường dữ liệu thuộc giấy này?`))return;
  delete state.documents[k];clearDocumentFields(k);
  if(activeDoc===k){activeDoc=null;activeImage=null;previewZoom=1;currentEvidence=null;drawPreview(null,null);}
  renderDocuments();renderFields();toast('Đã xóa ảnh và dữ liệu OCR của giấy này.');
}
async function viewDocument(k){
  activeDoc=k;const d=state.documents[k];previewZoom=1;currentEvidence=null;
  if(d?.blob){activeImage=await loadImage(URL.createObjectURL(d.blob));drawPreview(activeImage,null);}else{activeImage=null;drawPreview(null,null);}renderDocuments();
}
function statusClass(f){if(!f.value)return 'status-empty';if(f.confidence>=90)return 'status-good';if(f.confidence>=75)return 'status-warn';return 'status-bad'}
function statusText(f){if(!f.value)return 'Chưa có';if(f.verified)return 'Đã nhập/sửa';if(f.confidence>=90)return 'Tin cậy cao';if(f.confidence>=75)return 'Cần kiểm tra';return 'Bắt buộc kiểm tra'}
function renderFields(){
  const el=$('#fields');el.innerHTML='';
  Object.entries(FIELDS).forEach(([k,label])=>{
    const f=state.fields[k];const div=document.createElement('div');div.className='field-card '+statusClass(f);
    div.innerHTML=`<div class="field-label"><span>${esc(label)}</span><span class="confidence">${f.value?(f.verified?'Đã sửa':f.confidence+'%'):'—'}</span></div><input class="field-input" data-field="${k}" value="${esc(f.value)}" placeholder="Chưa xác định – có thể nhập trực tiếp" />`;
    div.onclick=e=>{if(e.target.tagName!=='INPUT')showEvidence(k)};
    const inp=div.querySelector('input');inp.oninput=e=>{const v=e.target.value;state.fields[k].value=v.trim();state.fields[k].verified=true;state.fields[k].confidence=v.trim()?100:0;if(!v.trim())state.fields[k].evidence=null;};inp.onblur=()=>renderFields();
    el.appendChild(div);
  });
}
async function showEvidence(k){
  const f=state.fields[k];const owner=Object.entries(DOCS).find(([,d])=>d.fields.includes(k))?.[0];if(owner&&state.documents[owner])await viewDocument(owner);
  if(f.evidence?.bbox)focusEvidence(f.evidence.bbox);else drawPreview(activeImage,null);
  $('#ocrStatus').textContent=f.evidence?.text?`Nguồn OCR: “${f.evidence.text}” • ${f.confidence}%`:'Trường này được nhập/sửa thủ công hoặc chưa có vùng OCR.';
  switchMobileTab('image');
}
function handleFile(input){const file=input.files?.[0];if(file&&pendingDoc)processImage(pendingDoc,file);input.value='';}
$('#cameraInput').onchange=e=>handleFile(e.target);$('#uploadInput').onchange=e=>handleFile(e.target);

// IndexedDB: giữ nguyên tên DB của V1 để dữ liệu cũ tiếp tục dùng được.
const DB_NAME='GPPDataEntryLiteV1';let dbp=null;
function db(){if(dbp)return dbp;dbp=new Promise((res,rej)=>{const r=indexedDB.open(DB_NAME,1);r.onupgradeneeded=()=>{const d=r.result;if(!d.objectStoreNames.contains('records'))d.createObjectStore('records',{keyPath:'id'})};r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});return dbp}
async function putRecord(rec){const d=await db();return new Promise((res,rej)=>{const tx=d.transaction('records','readwrite');tx.objectStore('records').put(rec);tx.oncomplete=res;tx.onerror=()=>rej(tx.error)})}
async function allRecords(){const d=await db();return new Promise((res,rej)=>{const r=d.transaction('records').objectStore('records').getAll();r.onsuccess=()=>res(r.result||[]);r.onerror=()=>rej(r.error)})}
async function getRecord(id){const d=await db();return new Promise((res,rej)=>{const r=d.transaction('records').objectStore('records').get(id);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
async function deleteRecord(id){const d=await db();return new Promise((res,rej)=>{const tx=d.transaction('records','readwrite');tx.objectStore('records').delete(id);tx.oncomplete=res;tx.onerror=()=>rej(tx.error)})}
async function saveCurrent(){
  const low=Object.entries(state.fields).filter(([,f])=>f.value&&!f.verified&&f.confidence<75);if(low.length&&!confirm(`Có ${low.length} trường OCR độ tin cậy thấp. Vẫn lưu hồ sơ?`))return false;
  refreshBanHanhDefault();
  state.updatedAt=new Date().toISOString();await putRecord(state);toast('Đã lưu hồ sơ trên thiết bị.');await renderRecords($('#searchRecords').value);return true;
}
async function renderRecords(q=''){
  const arr=await allRecords();const n=noAccent(q);const body=$('#recordsBody');body.innerHTML='';
  arr.sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||'')).filter(r=>!n||noAccent(Object.values(r.fields||{}).map(x=>x?.value||'').join(' ')).includes(n)).forEach((raw,idx)=>{
    const r=hydrateState(raw),v=k=>r.fields[k]?.value||'';const tr=document.createElement('tr');
    tr.innerHTML=`<td>${idx+1}</td><td>${esc(v('ten_co_so'))}</td><td>${esc(v('loai_co_so'))}</td><td>${esc(v('so_cchnd'))}</td><td>${esc(v('so_ddkkdd'))}</td><td>${esc(v('so_gpp'))}</td><td>${r.updatedAt?new Date(r.updatedAt).toLocaleString('vi-VN'):''}</td><td><button class="btn small secondary" data-open="${r.id}">Mở</button> <button class="btn small danger" data-del="${r.id}">Xóa</button></td>`;body.appendChild(tr);
  });
  body.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>openSavedRecord(b.dataset.open));
  body.querySelectorAll('[data-del]').forEach(b=>b.onclick=async()=>{if(confirm('Xóa hồ sơ này khỏi thiết bị?')){await deleteRecord(b.dataset.del);await renderRecords($('#searchRecords').value);toast('Đã xóa hồ sơ.')}});
}
async function openSavedRecord(id){
  const raw=await getRecord(id);if(!raw)return;state=hydrateState(raw);activeDoc=null;activeImage=null;previewZoom=1;currentEvidence=null;renderAll();closeModal('recordsModal');openRecordSheet();toast('Đã mở hồ sơ.');
}
function newRecord(){if(confirm('Tạo hồ sơ mới? Dữ liệu chưa lưu hiện tại sẽ bị bỏ.')){state=freshState();activeDoc=null;activeImage=null;previewZoom=1;currentEvidence=null;renderAll();switchMobileTab('docs');}}
async function exportExcel(){
  const arr=await allRecords();if(!arr.length){toast('Chưa có hồ sơ để xuất.');return}
  const headers=['Tên cơ sở','Loại cơ sở','Điện thoại','Địa chỉ','Số CCHND','Ngày cấp CCHND','Nơi cấp CCHND','Người PTCM','Năm cấp bằng','Trường tốt nghiệp','Số ĐĐKKDD','Ngày cấp ĐĐKKDD','Số GPP','Ngày cấp GPP'];
  const keys=['ten_co_so','loai_co_so','dien_thoai','dia_chi','so_cchnd','ngay_cap_cchnd','noi_cap_cchnd','nguoi_ptcm','nam_cap_bang','truong_tot_nghiep','so_ddkkdd','ngay_cap_ddkkdd','so_gpp','ngay_cap_gpp'];
  const data=[headers,...arr.map(raw=>{const r=hydrateState(raw);return keys.map(k=>r.fields[k]?.value||'')})];
  if(window.XLSX){const ws=XLSX.utils.aoa_to_sheet(data);ws['!cols']=headers.map((h,i)=>({wch:Math.max(14,Math.min(45,Math.max(h.length+2,...data.slice(1).map(row=>String(row[i]||'').length+2))))}));const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'Ho so');XLSX.writeFile(wb,`GPP_Data_Entry_${new Date().toISOString().slice(0,10)}.xlsx`);}else{const csv=data.map(row=>row.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\n');const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv'}));a.download='GPP_Data_Entry.csv';a.click();}
}

function openModal(id){const m=$('#'+id);m.classList.add('open');m.setAttribute('aria-hidden','false');}
function closeModal(id){const m=$('#'+id);m.classList.remove('open');m.setAttribute('aria-hidden','true');}
async function openRecordsModal(){await renderRecords($('#searchRecords').value);openModal('recordsModal');}
function openRecordSheet(){
  refreshBanHanhDefault();
  const body=$('#recordSheetBody');body.innerHTML='';$('#recordModalTitle').textContent=`Chi tiết hồ sơ${state.fields.ten_co_so.value?' – '+state.fields.ten_co_so.value:''}`;
  const bh=state.banHanh||{value:'',manual:false};
  const bhRow=document.createElement('tr');
  bhRow.innerHTML=`<td>1</td><td>Ban hành</td><td><input class="sheet-input" data-sheet-meta="banHanh" value="${esc(bh.value)}" placeholder="Có thể nhập hoặc sửa trực tiếp" /></td><td><span class="sheet-status ${bh.value?'good':'empty'}">${bh.manual?'Đã chỉnh thủ công':(bh.value?'Tự động theo số loại giấy':'Chưa xác định')}</span></td>`;
  body.appendChild(bhRow);
  FIELD_ORDER.forEach((k,idx)=>{const f=state.fields[k];const tr=document.createElement('tr');const s=statusText(f),cls=!f.value?'empty':f.verified?'good':f.confidence>=90?'good':f.confidence>=75?'warn':'bad';
    tr.innerHTML=`<td>${idx+2}</td><td>${esc(FIELDS[k])}</td><td><input class="sheet-input" data-sheet-field="${k}" value="${esc(f.value)}" placeholder="Có thể nhập trực tiếp" /></td><td><span class="sheet-status ${cls}">${esc(s)}</span></td>`;body.appendChild(tr);
  });
  body.querySelectorAll('[data-sheet-meta="banHanh"]').forEach(inp=>{inp.oninput=e=>{state.banHanh={value:e.target.value.trim(),manual:true};const st=e.target.closest('tr')?.querySelector('.sheet-status');if(st){st.textContent='Đã chỉnh thủ công';st.className='sheet-status '+(state.banHanh.value?'good':'empty');}};});
  body.querySelectorAll('[data-sheet-field]').forEach(inp=>{inp.oninput=e=>{const k=e.target.dataset.sheetField,v=e.target.value.trim();state.fields[k].value=v;state.fields[k].verified=true;state.fields[k].confidence=v?100:0;if(!v)state.fields[k].evidence=null;};});
  openModal('recordModal');
}

function switchMobileTab(tab){
  document.querySelectorAll('.panel[data-tab]').forEach(p=>p.classList.toggle('mobile-active',p.dataset.tab===tab));
  document.querySelectorAll('[data-mobile-tab]').forEach(b=>b.classList.toggle('active',b.dataset.mobileTab===tab));
  if(tab==='image'&&activeImage)setTimeout(()=>drawPreview(activeImage,currentEvidence),40);
}
function renderAll(){renderDocuments();renderFields();drawPreview(activeImage,currentEvidence);renderRecords($('#searchRecords').value);$('#ocrStatus').textContent='Sẵn sàng.';}

// Kéo ảnh để di chuyển khi đã zoom. Hoạt động bằng chuột, bút và một ngón tay.
const panState={active:false,id:null,x:0,y:0,left:0,top:0};
function endPan(e){const wrap=$('#previewWrap');if(!panState.active)return;panState.active=false;wrap.classList.remove('dragging');try{if(panState.id!==null)wrap.releasePointerCapture(panState.id)}catch(_e){}panState.id=null;}
$('#previewWrap').addEventListener('pointerdown',e=>{
  if(!activeImage||e.button>0)return;const wrap=$('#previewWrap');panState.active=true;panState.id=e.pointerId;panState.x=e.clientX;panState.y=e.clientY;panState.left=wrap.scrollLeft;panState.top=wrap.scrollTop;wrap.classList.add('dragging');try{wrap.setPointerCapture(e.pointerId)}catch(_e){}e.preventDefault();
});
$('#previewWrap').addEventListener('pointermove',e=>{if(!panState.active||e.pointerId!==panState.id)return;const wrap=$('#previewWrap');wrap.scrollLeft=panState.left-(e.clientX-panState.x);wrap.scrollTop=panState.top-(e.clientY-panState.y);e.preventDefault();});
$('#previewWrap').addEventListener('pointerup',endPan);$('#previewWrap').addEventListener('pointercancel',endPan);$('#previewWrap').addEventListener('dblclick',()=>{if(!activeImage)return;previewZoom=1;drawPreview(activeImage,currentEvidence);$('#previewWrap').scrollTo(0,0)});

// Điều khiển ảnh
$('#previewWrap').addEventListener('wheel',e=>{if(!activeImage)return;e.preventDefault();const rect=$('#previewWrap').getBoundingClientRect();const fp={x:$('#previewWrap').scrollLeft+(e.clientX-rect.left),y:$('#previewWrap').scrollTop+(e.clientY-rect.top)};setPreviewZoom(previewZoom*(e.deltaY<0?1.14:1/1.14),fp);},{passive:false});
$('#btnZoomIn').onclick=()=>setPreviewZoom(previewZoom*1.2);$('#btnZoomOut').onclick=()=>setPreviewZoom(previewZoom/1.2);$('#btnZoomFit').onclick=()=>{previewZoom=1;drawPreview(activeImage,currentEvidence);$('#previewWrap').scrollTo(0,0)};
window.addEventListener('resize',()=>{if(activeImage)drawPreview(activeImage,currentEvidence)});

document.addEventListener('dragover',e=>{if(e.dataTransfer?.types?.includes('Files'))e.preventDefault();});
document.addEventListener('drop',e=>{if(e.dataTransfer?.types?.includes('Files')&&!e.target.closest?.('[data-drop-doc]'))e.preventDefault();});

// Nút / modal / mobile
$('#btnNew').onclick=newRecord;$('#btnSave').onclick=saveCurrent;$('#btnExport').onclick=exportExcel;$('#btnRecords').onclick=openRecordsModal;$('#btnRecordsMobile').onclick=openRecordsModal;$('#searchRecords').oninput=e=>renderRecords(e.target.value);$('#btnSaveSheet').onclick=async()=>{renderFields();if(await saveCurrent()){openRecordSheet();toast('Đã lưu thay đổi của hồ sơ.')}};
document.querySelectorAll('[data-close-modal]').forEach(b=>b.onclick=()=>closeModal(b.dataset.closeModal));
document.querySelectorAll('.modal').forEach(m=>m.addEventListener('mousedown',e=>{if(e.target===m)closeModal(m.id)}));
document.querySelectorAll('[data-mobile-tab]').forEach(b=>b.onclick=()=>switchMobileTab(b.dataset.mobileTab));
document.addEventListener('keydown',e=>{if(e.key==='Escape'){document.querySelectorAll('.modal.open').forEach(m=>closeModal(m.id));}});


/* ================================================================
   V1.2.18 - Android/PWA capture layer. OCR/rule V1.2.17 không đổi.
   ================================================================ */
const MOBILE_CAPTURE_ORDER=['cchnd','gpkd','bang','ddkkdd','gpp'];
let mobileCameraStream=null,mobileCaptureIndex=0,mobileSingleDoc=null,deferredInstallPrompt=null,pwaRegistration=null;
function isMobileCaptureEnvironment(){
  return window.matchMedia('(max-width:760px)').matches||/Android|iPhone|iPad|iPod/i.test(navigator.userAgent||'');
}
function isStandaloneApp(){return window.matchMedia('(display-mode: standalone)').matches||window.navigator.standalone===true;}
function setMobileIntro(on){
  if(!isMobileCaptureEnvironment())on=false;
  document.body.classList.toggle('mobile-intro-mode',!!on);
  const el=$('#mobileIntro');if(el)el.setAttribute('aria-hidden',on?'false':'true');
}
function updatePWAActionButtons(){
  const install=$('#btnPwaInstall'),update=$('#btnPwaUpdate');
  if(install)install.hidden=!(deferredInstallPrompt&&!isStandaloneApp());
  if(update)update.hidden=!(pwaRegistration?.waiting);
}
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstallPrompt=e;updatePWAActionButtons();});
window.addEventListener('appinstalled',()=>{deferredInstallPrompt=null;updatePWAActionButtons();});
async function installPWA(){
  if(!deferredInstallPrompt)return;const p=deferredInstallPrompt;deferredInstallPrompt=null;updatePWAActionButtons();
  try{await p.prompt();await p.userChoice;}catch(e){}
  updatePWAActionButtons();
}
async function applyPWAUpdate(){
  if(!pwaRegistration?.waiting)return;
  pwaRegistration.waiting.postMessage({type:'SKIP_WAITING'});
}
async function registerPWAUpdateFlow(){
  if(!('serviceWorker' in navigator)||!location.protocol.startsWith('http'))return;
  try{
    pwaRegistration=await navigator.serviceWorker.register('./service-worker.js');
    updatePWAActionButtons();
    pwaRegistration.addEventListener('updatefound',()=>{
      const w=pwaRegistration.installing;if(!w)return;
      w.addEventListener('statechange',()=>{if(w.state==='installed'&&navigator.serviceWorker.controller)updatePWAActionButtons();});
    });
    navigator.serviceWorker.addEventListener('controllerchange',()=>location.reload());
    pwaRegistration.update().catch(()=>{});
  }catch(e){console.warn('PWA:',e);}
}
function stopMobileCamera(){
  if(mobileCameraStream){mobileCameraStream.getTracks().forEach(t=>{try{t.stop()}catch(e){}});mobileCameraStream=null;}
  const v=$('#mobileCameraVideo');if(v){v.srcObject=null;}
}
function closeMobileCamera(showMain=true){
  stopMobileCamera();document.body.classList.remove('mobile-camera-open');
  const el=$('#mobileCapture');if(el)el.setAttribute('aria-hidden','true');
  try{if(document.fullscreenElement)document.exitFullscreen?.();}catch(e){}
  mobileSingleDoc=null;
  if(showMain){setMobileIntro(false);switchMobileTab('docs');}
}
function updateMobileCaptureLabels(){
  const k=mobileSingleDoc||MOBILE_CAPTURE_ORDER[Math.max(0,Math.min(MOBILE_CAPTURE_ORDER.length-1,mobileCaptureIndex))];
  const name=DOCS[k]?.name||'Tài liệu';
  if($('#mobileCaptureDocName'))$('#mobileCaptureDocName').textContent=name;
  if($('#mobileCaptureCounter'))$('#mobileCaptureCounter').textContent=mobileSingleDoc?'Chụp bổ sung':`${mobileCaptureIndex+1}/${MOBILE_CAPTURE_ORDER.length}`;
}
async function startMobileCameraStream(){
  if(!navigator.mediaDevices?.getUserMedia)throw new Error('Trình duyệt chưa cho phép camera trực tiếp.');
  stopMobileCamera();
  const constraints={video:{facingMode:{ideal:'environment'},width:{ideal:2560},height:{ideal:1920}},audio:false};
  mobileCameraStream=await navigator.mediaDevices.getUserMedia(constraints);
  const v=$('#mobileCameraVideo');v.srcObject=mobileCameraStream;await v.play();
}
async function openMobileCamera(singleDoc=null){
  mobileSingleDoc=singleDoc;if(singleDoc)mobileCaptureIndex=Math.max(0,MOBILE_CAPTURE_ORDER.indexOf(singleDoc));
  updateMobileCaptureLabels();setMobileIntro(false);document.body.classList.add('mobile-camera-open');
  $('#mobileCapture').setAttribute('aria-hidden','false');
  try{await $('#mobileCapture').requestFullscreen?.();}catch(e){}
  try{await startMobileCameraStream();}
  catch(e){
    console.warn('Camera trực tiếp:',e);document.body.classList.remove('mobile-camera-open');
    $('#mobileCapture').setAttribute('aria-hidden','true');stopMobileCamera();
    pendingDoc=singleDoc||MOBILE_CAPTURE_ORDER[mobileCaptureIndex];$('#mobileCameraFallback').click();
  }
}
function openMobileCameraForSingleDoc(docType){return openMobileCamera(docType);}
function frameCropToFile(){
  const v=$('#mobileCameraVideo'),frame=$('#mobileCaptureFrame');
  if(!v||!frame||!v.videoWidth||!v.videoHeight)throw new Error('Camera chưa sẵn sàng.');
  const vr=v.getBoundingClientRect(),fr=frame.getBoundingClientRect();
  const vw=v.videoWidth,vh=v.videoHeight;
  // video dùng object-fit:cover: ánh xạ khung màn hình ngược về pixel camera.
  const scale=Math.max(vr.width/vw,vr.height/vh);
  const shownW=vw*scale,shownH=vh*scale;
  const offsetX=vr.left+(vr.width-shownW)/2,offsetY=vr.top+(vr.height-shownH)/2;
  let sx=(fr.left-offsetX)/scale,sy=(fr.top-offsetY)/scale,sw=fr.width/scale,sh=fr.height/scale;
  sx=Math.max(0,Math.min(vw-1,sx));sy=Math.max(0,Math.min(vh-1,sy));sw=Math.max(1,Math.min(vw-sx,sw));sh=Math.max(1,Math.min(vh-sy,sh));
  const maxSide=2400,down=Math.min(1,maxSide/Math.max(sw,sh));
  const c=document.createElement('canvas');c.width=Math.max(1,Math.round(sw*down));c.height=Math.max(1,Math.round(sh*down));
  c.getContext('2d').drawImage(v,sx,sy,sw,sh,0,0,c.width,c.height);
  return new Promise((res,rej)=>c.toBlob(blob=>blob?res(new File([blob],`GPP_${Date.now()}.jpg`,{type:'image/jpeg',lastModified:Date.now()})):rej(new Error('Không tạo được ảnh chụp.')),'image/jpeg',.94));
}
async function shootMobileDocument(){
  const k=mobileSingleDoc||MOBILE_CAPTURE_ORDER[mobileCaptureIndex];if(!k)return;
  const btn=$('#btnShootMobileDoc');if(btn)btn.disabled=true;
  try{
    const file=await frameCropToFile();await processImage(k,file);
    if(mobileSingleDoc){closeMobileCamera(true);toast(`Đã chụp ${DOCS[k].name}.`);return;}
    mobileCaptureIndex++;
    if(mobileCaptureIndex>=MOBILE_CAPTURE_ORDER.length){closeMobileCamera(true);toast('Đã hoàn tất lượt chụp hồ sơ. OCR tiếp tục xử lý ở nền.');return;}
    updateMobileCaptureLabels();
  }catch(e){console.error(e);toast(e.message||'Không chụp được ảnh.');}
  finally{if(btn)btn.disabled=false;}
}
function skipMobileDocument(){
  if(mobileSingleDoc){closeMobileCamera(true);return;}
  mobileCaptureIndex++;
  if(mobileCaptureIndex>=MOBILE_CAPTURE_ORDER.length){closeMobileCamera(true);toast('Đã kết thúc lượt chụp hồ sơ.');return;}
  updateMobileCaptureLabels();
}
async function startMobileProfileFlow(){
  // Mỗi lần bấm Bắt đầu là một hồ sơ mới, nhưng không bật confirm ở màn hình khởi động.
  mobileCaptureIndex=0;mobileSingleDoc=null;
  if(Object.keys(state.documents||{}).length||FIELD_ORDER.some(k=>state.fields[k]?.value))state=freshState();
  activeDoc=null;activeImage=null;previewZoom=1;currentEvidence=null;renderAll();
  await openMobileCamera(null);
}
function handleMobileFallback(input){
  const file=input.files?.[0],k=pendingDoc;if(file&&k)processImage(k,file);
  input.value='';
  if(mobileSingleDoc){setMobileIntro(false);switchMobileTab('docs');mobileSingleDoc=null;return;}
  if(isMobileCaptureEnvironment()){
    mobileCaptureIndex=Math.max(0,MOBILE_CAPTURE_ORDER.indexOf(k))+1;
    if(mobileCaptureIndex<MOBILE_CAPTURE_ORDER.length)setTimeout(()=>openMobileCamera(null),250);else{setMobileIntro(false);switchMobileTab('docs');}
  }
}
$('#btnMobileStart').onclick=startMobileProfileFlow;
$('#btnCloseMobileCamera').onclick=()=>closeMobileCamera(true);
$('#btnSkipMobileDoc').onclick=skipMobileDocument;
$('#btnShootMobileDoc').onclick=shootMobileDocument;
$('#btnPwaInstall').onclick=installPWA;
$('#btnPwaUpdate').onclick=applyPWAUpdate;
$('#mobileCameraFallback').onchange=e=>handleMobileFallback(e.target);
document.addEventListener('visibilitychange',()=>{if(document.hidden&&document.body.classList.contains('mobile-camera-open')){/* Android có thể tạm ẩn app khi cấp quyền; không tự đóng camera. */}});
if(isMobileCaptureEnvironment())setMobileIntro(true);else setMobileIntro(false);
registerPWAUpdateFlow();
renderAll();
