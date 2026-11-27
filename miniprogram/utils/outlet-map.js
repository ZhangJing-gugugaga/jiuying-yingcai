const minScale=3;
const maxScale=20;
const pin='/assets/outlet-map-pin.png';
const normalizeLongitude=value=>((value+540)%360)-180;

function coordinate(record, directory){
  const point=record.publicLocation;
  const raw=directory?(point?{lat:point.latitude,lng:point.longitude}:record.publicCoords):(record.coords||record.publicCoords);
  if(!Number.isFinite(raw?.lat)||!Number.isFinite(raw?.lng)||Math.abs(raw.lat)>90||Math.abs(raw.lng)>180)return null;
  return {latitude:raw.lat,longitude:raw.lng};
}

function viewport(points){
  if(!points.length)return null;
  if(points.length===1)return {lat:points[0].latitude,lng:points[0].longitude,scale:14};
  const longitudes=points.map(point=>point.longitude).sort((a,b)=>a-b);
  let minimum=longitudes[0], longitudeSpan=360;
  for(let index=0;index<longitudes.length;index++){
    const next=longitudes[(index+1)%longitudes.length]+(index===longitudes.length-1?360:0);
    const span=360-(next-longitudes[index]);
    if(span<longitudeSpan){minimum=next;longitudeSpan=span;}
  }
  let south=90,north=-90;
  for(const {latitude} of points){south=Math.min(south,latitude);north=Math.max(north,latitude);}
  const span=Math.max(longitudeSpan,(north-south)*1.4,0.001);
  const scale=Math.max(minScale,Math.min(15,Math.floor(Math.log2(260/span))));
  return {lat:(north+south)/2,lng:normalizeLongitude(minimum+longitudeSpan/2),scale};
}

function markers(outlets,directory,scale,longitude=0,grouped=false){
  const cells=new Map();
  const step=22.5/(2**(Math.max(minScale,Math.min(maxScale,scale))-minScale));
  for(const row of outlets){
    const point=coordinate(row,directory);
    if(!point)continue;
    const lng=normalizeLongitude(point.longitude-longitude);
    const key=grouped?Math.floor(point.latitude/step)+':'+Math.floor(lng/step):
      directory?row.id:point.latitude+':'+point.longitude;
    if(!cells.has(key))cells.set(key,[]);
    cells.get(key).push({row,point,lng});
  }
  return Array.from(cells.values(),(cell,id)=>{
    const first=cell[0],count=cell.length;
    const anchor=count>1
      ? {latitude:cell.reduce((sum,x)=>sum+x.point.latitude,0)/count,longitude:normalizeLongitude(longitude+cell.reduce((sum,x)=>sum+x.lng,0)/count)}
      : first.point;
    return {
      id,outletId:first.row.id,...anchor,title:count===1?first.row.name:count+' 家网点',
      width:24,height:32,iconPath:pin,
      ...(count===1?{}:{outletIds:cell.map(x=>x.row.id),label:{
        content:String(count),color:'#ffffff',bgColor:'#174A80',padding:4,borderRadius:8,fontSize:11,anchorX:13,anchorY:-25
      }})
    };
  });
}

module.exports={coordinate,viewport,markers,minScale,maxScale};
