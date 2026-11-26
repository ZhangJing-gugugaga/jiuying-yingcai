'use strict';
const path=require('node:path'),PDFDocument=require('pdfkit');
module.exports=function exportPdf(rows,{development=true}={}){return new Promise((resolve,reject)=>{
 const doc=new PDFDocument({size:'A4',margins:{top:42,bottom:42,left:42,right:42},bufferPages:true,info:{Title:'九盈英才 · 经营报告',Author:'九盈英才'}}),chunks=[];
 doc.on('data',c=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);
 doc.font(path.resolve(__dirname,'../assets/fonts/NotoSansCJKsc-Regular.otf'));
 const left=42,width=511,bottom=778,green='#173f38',ink='#344b42',muted='#7c897e';let y=42;
 const text=(value,x,top,opts={})=>doc.text(String(value??'—'),x,top,{lineBreak:false,...opts});
 function nextPage(){doc.addPage();y=42;doc.fontSize(9).fillColor(muted);text('九盈英才  /  经营报告',left,y);y+=29;}
 function lineWrap(value,w,size=8.5){doc.fontSize(size);const result=[];for(const paragraph of String(value??'—').split(/\r?\n/)){let line='';for(const ch of paragraph){if(line&&doc.widthOfString(line+ch)>w){result.push(line);line=ch;}else line+=ch;}result.push(line);}return result;}
 function heading(value){if(y+115>bottom)nextPage();y+=12;doc.fontSize(12).fillColor(green);text(value,left,y);y+=27;}
 function table(headers,data,widths){const head=()=>{const wrapped=headers.map((v,i)=>lineWrap(String(v).replace('（','\n（'),widths[i]-16,8)),h=Math.max(...wrapped.map(v=>v.length))*13+16;doc.rect(left,y,width,h).fill('#edf2e9');let x=left;doc.fontSize(8).fillColor(green);wrapped.forEach((lines,i)=>{lines.forEach((v,n)=>text(v,x+8,y+7+n*13));x+=widths[i];});y+=h;};if(y+65>bottom)nextPage();head();for(const row of data){const lines=widths.map((w,i)=>lineWrap(row[i],w-16));let position=0,total=Math.max(...lines.map(v=>v.length));while(position<total){if(bottom-y<28){nextPage();head();}const count=Math.min(total-position,Math.max(1,Math.floor((bottom-y-12)/12))),h=count*12+12;let x=left;doc.fontSize(8.5).fillColor(ink);lines.forEach((cell,i)=>{cell.slice(position,position+count).forEach((v,n)=>text(v,x+8,y+5+n*12));x+=widths[i];});doc.strokeColor('#e8ece5').lineWidth(.5).moveTo(left,y+h).lineTo(left+width,y+h).stroke();y+=h;position+=count;}}y+=7;}
 doc.fontSize(9).fillColor(muted);text('JIUYING  /  BUSINESS REPORT',left,y);y+=24;
 doc.fontSize(24).fillColor(green);text('九盈英才 · 经营报告',left,y);y+=43;
 doc.fontSize(8).fillColor(muted);text(development?'本地开发数据 · 非集团真实经营记录':'仅包含当前授权范围 · 请妥善保管',left,y);y+=24;
 doc.strokeColor(green).lineWidth(2).moveTo(left,y).lineTo(left+width,y).stroke();y+=18;
 doc.fontSize(9).fillColor(ink);text(rows[1].join('  '),left,y);y+=30;
 let index=3;const main=[];while(index<rows.length&&rows[index].length)main.push(rows[index++]);const n=rows[2].length;
 table(rows[2],main,[133,...Array(n-2).fill((width-196)/(n-2)),63]);
 while(index<rows.length){const row=rows[index++];if(!row.length)continue;
  if(row[0]==='近六月趋势'){heading('近六月趋势');const data=[];while(index<rows.length&&rows[index].length)data.push(rows[index++]);table(['月份',...row.slice(1)],data,[92,...Array(row.length-1).fill((width-92)/(row.length-1))]);}
  else if(row[0]==='经营说明'||row[0]==='异常提示'){heading(row[0]);const data=[];while(index<rows.length&&rows[index].length)data.push(rows[index++]);if(data.length)table(['网点 / 范围','月份','说明'],data,[133,67,311]);}
  else if(row[0]==='报送覆盖'){heading('报送覆盖 · 网点 × 已结束自然月');const data=[];while(index<rows.length&&rows[index].length)data.push(rows[index++]);table(['状态','数量','状态','数量'],data,[175,80,176,80]);}
  else if(row[0]==='独立排名'){heading('独立排名 · '+row[1]);const data=[];while(index<rows.length&&rows[index].length)data.push(rows[index++]);table(['排名','网点',row[1]],data,[52,310,149]);}
  else {const wrapped=lineWrap(row.join('  '),width,8);if(y+wrapped.length*13+15>bottom)nextPage();doc.fontSize(8).fillColor(muted);wrapped.forEach(v=>{text(v,left,y);y+=13;});y+=5;}
 }
 const pages=doc.bufferedPageRange();for(let p=0;p<pages.count;p++){doc.switchToPage(p);doc.page.margins.bottom=0;doc.fontSize(8).fillColor(muted);text('九盈英才  /  授权经营资料',left,810);text(`${p+1} / ${pages.count}`,left,810,{width,align:'right'});}doc.end();
});};
