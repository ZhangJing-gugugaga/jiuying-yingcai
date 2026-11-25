const {define,go,api,fmt}=require('../../utils/page');
const mapView=require('../../utils/outlet-map');
const {publicShare,directory:directoryShare}=require('../../utils/public-share');
const {recentSearches,addRecentSearch,clearRecentSearches}=require('../../utils/public-outlet-preferences');
const {outletSummaryRows,outletSummaryStatus}=require('../../utils/outlet-summary');
const {withPublicCover,retainPublicCover,markCoverUnavailable}=require('../../utils/public-content');

const geography=[
  {value:'all',label:'全部地区'},
  {value:'mainland',label:'国内'},
  {value:'overseas',label:'境外'}
];
const allCountries={code:'',name:'全部国家或地区'};
const pointPageSize=200;
const mapError='暂时无法加载网点地图，请重试。仍可查看下方网点地址。';

const statusFilters=[{value:'all',label:'全部'},...['preparing','open','paused','closed'].map(value=>({value,label:fmt.label(value,'outlet')}))];
const nextActions=[
  {key:'report',status:'returned',page:'report',label:'修改月报'},
  {key:'location',status:'exception',page:'location',label:'补充位置资料'},
  {key:'report',status:'missing',page:'report',label:'填写月报'},
  {key:'location',status:'missing',page:'location',label:'提交位置资料'},
  {key:'fee',status:'unpaid',page:'fees',label:'查看账单'},
  {key:'fee',status:'partially_paid',page:'fees',label:'查看账单'}
];
function privateRow(outlet){
  const {summary,countryCode,countryName,province,city,district,status}=outlet;
  const activity=nextActions.find(({key,status})=>summary?.[key]?.status===status&&fmt.monthText(summary[key].month));
  const waiting=summary?.report?.status==='exemption_pending'?'免报待审核':summary?.location?.status==='pending'?'等待总部核验':'';
  const area=(countryCode&&countryCode!=='CN'?[countryName,city]:[city||province,district])
    .filter((name,index,all)=>name&&all.indexOf(name)===index).join(' · ');
  const rows=outletSummaryRows(summary);
  let nextAction=null;
  if(activity){
    const {key,page,label}=activity;
    const {title,monthText}=rows.find(row=>row.key===key);
    const statusText=outletSummaryStatus(key,activity.status);
    const returnedVersionId=key==='report'&&activity.status==='returned'?summary.report.returnedVersionId:undefined;
    nextAction={page,label,month:summary[key].month,monthText,text:[title,monthText,statusText].join(' · '),returnedVersionId};
  }
  return {...outlet,area,imageId:outlet.publishedImageId,statusText:fmt.label(status,'outlet'),statusTone:fmt.statusTone(status,'outlet'),
    summaryRows:rows,businessChips:rows.filter(row=>row.key==='report'||row.key==='fee').map(row=>({...row,
      label:row.key==='report'?'月报':'服务费',tone:fmt.statusTone(summary[row.key]?.status,row.key==='fee'?'bill':'report')})),
    nextAction,waitingText:nextAction?'':waiting};
}

function publicRow(outlet){
  const {id,name,address,status,province,city,countryCode,countryName,publicLocation,publicCoords,services,imageId}=outlet;
  const locality=[...new Set([countryName,city].filter(Boolean))];
  const addressStart=address?.split(/[·,，]/,1)[0].trim();
  const repeatedLocality=locality.indexOf(addressStart);
  const area=(repeatedLocality<0?locality:locality.slice(0,repeatedLocality)).join(' · ');
  const locationText=[area,address||'暂无可查看地址'].filter(Boolean).join(' · ');
  const serviceTags=Array.isArray(services)?services.slice(0,3):[];
  return {id,name,address,area,locationText,province,city,countryCode,countryName,
    statusText:fmt.label(status,'outlet'),statusTone:fmt.statusTone(status,'outlet'),
    services:serviceTags,servicesText:serviceTags.join('、'),publicLocation,publicCoords,imageId};
}

function groupRows(rows,directory){
  if(!directory)return [{key:'private',label:'',rows}];
  const groups=new Map();
  for(const row of rows){
    const overseas=row.countryCode&&row.countryCode!=='CN';
    const label=overseas?['境外',row.countryName,row.city].filter((name,index,all)=>name&&all.indexOf(name)===index).join(' · '):
      row.city||row.province||'其他地区';
    const key=JSON.stringify([row.countryCode||'CN',row.province||'',label]);
    if(!groups.has(key))groups.set(key,{key,label,rows:[]});
    groups.get(key).rows.push(row);
  }
  return Array.from(groups.values());
}

function resultScope(page,session=api.session()){
  const {search,region,statusFilter,geo,countryCode}=page.data;
  const directory=!session||session.role==='public'||page.query?.scope==='public';
  return JSON.stringify([session?.token||'',session?.role||'',page.query?.scope||'',search,region,
    directory?geo:statusFilter,directory?countryCode:'']);
}

const page=define({
  collections:[{
    name:'outlets',
    filters(){
      const directory=this.data.isPublic||this.query.scope==='public';
      const {search,region,statusFilter,geo,countryCode}=this.data;
      return {q:search,province:region[0],city:region[1],district:region[2],status:directory?'all':statusFilter,
        ...(directory?{scope:'public',geo,countryCode,includeCountries:this.data.countriesLoaded?undefined:'true'}:
          {includeSummary:'true',includeStatusCounts:'true'})};
    },
    metadata(result){
      this.setData({statusCounts:result.statusCounts||null});
      if(!Array.isArray(result.countries))return;
      this.updateCountries(result.countries);
      this.setData({countriesLoaded:true});
    }
  }],
  data:{
    directory:false,search:'',searchDraft:'',recentSearches:[],showRecent:false,region:[],showRegionFilters:false,statusFilter:'all',statusFilters,statusCounts:null,rows:[],groups:[],mode:'list',retainingRows:false,
    geography,geo:'all',countryCode:'',availableCountries:[],countryChoices:[allCountries],countryIndex:0,countriesLoaded:false,
    markers:[],center:null,zoom:mapView.minScale,minScale:mapView.minScale,maxScale:mapView.maxScale,
    mapLoading:false,mapError:'',pointCount:0,selectedPoint:null,clusterRows:[],clusterTotal:0
  },
  ...publicShare(()=>directoryShare,function(){return this.data.directory;}),
  load(q){
    this.query={};
    if(q.scope==='public'||q.scope==='private'){
      this.query.scope=q.scope;
      const publicDirectory=api.session()?.role==='public'||q.scope==='public';
      if(publicDirectory!==this.data.directory||q.mode)this.resetScope(publicDirectory);
    }
    if(q.scope==='public'&&geography.some(option=>option.value===q.geo)){
      this.setData({geo:q.geo});
    }
    if(q.mode==='map')this.setData({mode:'map'});
    else if(q.scope==='private'&&this.data.mode==='map')this.modeUnavailable();
  },
  async loaded(s){
    const directory=this.data.isPublic||this.query.scope==='public';
    const scope=resultScope(this,this.data.session);
    const pending=this._returning;
    if(pending?.serial===this._serial){
      this._returning=null;
      if(!directory&&pending.range.scope===scope){
        const {serial,range}=pending;
        while(serial===this._serial&&scope===resultScope(this)&&this.data.pagers.outlets?.hasMore&&
          this.data.pagers.outlets.loaded<range.loaded){
          await this.fetchCollection('outlets',false,serial,false);
        }
        if(serial!==this._serial||scope!==resultScope(this))return;
        s=this.data.state;
      }
    }
    const previous=this._rowScope===scope?new Map(this.data.rows.map(row=>[row.id,row])):new Map();
    const makeRow=directory?publicRow:privateRow;
    const rows=s.outlets.map(outlet=>retainPublicCover(makeRow(outlet),previous.get(outlet.id)));
    this._rowScope=scope;
    this.setData({directory,rows,groups:groupRows(rows,directory),recentSearches:directory?recentSearches():[]});
    this.updatePublicShareMenu();
    wx.setNavigationBarTitle?.({title:directory?'服务网点':'我的网点'});
    if(this.data.mode==='list')this.loadOutletCovers();
    if(directory&&this.data.mode==='map'){
      if(this._mapSerial!==this._serial)await this.loadPublicMap();
      return;
    }
    const points=rows.map(row=>mapView.coordinate(row,directory)).filter(Boolean);
    const viewport=mapView.viewport(points);
    this.setData({markers:mapView.markers(rows,directory,viewport?.scale||mapView.minScale),
      center:viewport,zoom:viewport?.scale||mapView.minScale});
  },
  async loadOutletCovers(){
    const serial=this._serial,scope=this._rowScope,attempt={};
    const {directory}=this.data;
    this._coverLoad=attempt;
    const current=()=>this._coverLoad===attempt&&this._serial===serial&&scope===this._rowScope&&
      directory===this.data.directory&&(directory||scope===resultScope(this));
    const pending=this.data.rows.filter(row=>row.imageId&&!row.coverPath&&!row.coverUnavailable);
    for(let start=0;start<pending.length&&current();start+=4){
      const loaded=await Promise.all(pending.slice(start,start+4).map(row=>withPublicCover(row,{allowVisitor:directory})));
      if(!current())return;
      const ready=new Map(loaded.map(row=>[row.id,row]));
      const rows=this.data.rows.map(row=>{
        const result=ready.get(row.id);
        return result&&result.imageId===row.imageId?result:row;
      });
      this.setData({rows,groups:groupRows(rows,directory)});
    }
  },
  coverFailed(e){
    const {id,imageId}=e.currentTarget.dataset;
    if(!this.data.rows.some(row=>row.id===id&&row.imageId===imageId&&row.coverPath))return;
    const rows=markCoverUnavailable(this.data.rows,id);
    this.setData({rows,groups:groupRows(rows,this.data.directory)});
  },
  resetScope(directory){
    this._mapRequest=(this._mapRequest||0)+1;
    this._mapKey=null;
    this._mapSerial=null;
    this._viewport=null;
    this._pointRows=[];
    this._cluster=[];
    this.setData({directory,search:'',searchDraft:'',recentSearches:directory?recentSearches():[],showRecent:false,region:[],showRegionFilters:false,statusFilter:'all',mode:'list',rows:[],groups:[],markers:[],center:null,
      geo:'all',countryCode:'',availableCountries:[],countryChoices:[allCountries],countryIndex:0,countriesLoaded:false,
      mapLoading:false,mapError:'',pointCount:0,selectedPoint:null,clusterRows:[],clusterTotal:0});
  },
  async changeScope(e){
    const {scope}=e.currentTarget.dataset;
    if(this.data.isPublic||!['public','private'].includes(scope)||this.data.directory===(scope==='public'))return;
    this.query={scope};
    this.resetScope(scope==='public');
    await this.refresh();
  },
  searchInput(e){this.setData({searchDraft:e.detail.value});},
  searchFocus(){if(this.data.directory)this.setData({showRecent:true});},
  async chooseRecent(e){
    const value=e.currentTarget.dataset.term;
    if(this.data.directory&&this.data.recentSearches.includes(value))await this.search({detail:{value}});
  },
  clearRecent(){
    if(!this.data.directory)return;
    try{
      clearRecentSearches();
      this.setData({recentSearches:[],showRecent:false});
    }catch{
      wx.showToast?.({title:'暂时无法清除搜索记录，请稍后重试。',icon:'none'});
    }
  },
  async search(e){
    const search=(e.detail?.value??this.data.searchDraft).trim();
    this.setData({search,searchDraft:search,showRecent:false,...(this.data.directory?{recentSearches:addRecentSearch(search)}:{})});
    await this.refresh();
  },
  async clearSearch(){
    const {search,error,directory}=this.data;
    this.setData({search:'',searchDraft:'',showRecent:directory});
    if(search||error)await this.refresh();
  },
  async clearFilters(){
    this.setData({search:'',searchDraft:'',showRecent:false,region:[],statusFilter:'all',geo:'all',countryCode:''});
    this.updateCountries();
    await this.refresh();
  },
  toggleRegionFilters(){this.setData({showRegionFilters:!this.data.showRegionFilters});},
  async region(e){this.setData({region:e.detail.value,countryCode:''});this.updateCountries();await this.refresh();},
  async clearRegion(){
    this.setData({region:[],countryCode:''});
    this.updateCountries();
    await this.refresh();
  },
  async filterStatus(e){this.setData({statusFilter:e.currentTarget.dataset.status});await this.refresh();},
  async filterGeography(e){
    const geo=e.currentTarget.dataset.geo;
    if(!geography.some(option=>option.value===geo)||geo===this.data.geo)return;
    this.setData({geo,countryCode:'',region:[]});
    this.updateCountries();
    await this.refresh();
  },
  updateCountries(countries=this.data.availableCountries){
    const {geo,countryCode}=this.data;
    const choices=[allCountries,...countries.filter(x=>x&&
      typeof x.code==='string'&&typeof x.name==='string'&&
      (geo==='all'||(geo==='mainland'?(x.code==='CN'):(x.code!=='CN'))))];
    this.setData({availableCountries:countries,countryChoices:choices,
      countryIndex:Math.max(0,choices.findIndex(x=>x.code===countryCode))});
  },
  async filterCountry(e){
    const choice=this.data.countryChoices[Number(e.detail.value)];
    if(!choice||choice.code===this.data.countryCode)return;
    this.setData({countryCode:choice.code,region:[]});
    this.updateCountries();
    await this.refresh();
  },
  async mode(e){
    const {mode}=e.currentTarget.dataset;
    if(!this.data.directory||!['list','map'].includes(mode)||mode===this.data.mode)return;
    if(mode==='list')return this.modeUnavailable();
    this.setData({mode,mapError:'',selectedPoint:null,clusterRows:[],clusterTotal:0});
    if(this.data.directory)await this.loadPublicMap();
  },
  async loadPublicMap(){
    if(!this.data.directory||this.data.mode!=='map')return;
    const serial=this._serial;
    const request=(this._mapRequest||0)+1;
    this._mapRequest=request;
    this._mapSerial=serial;
    const current=()=>request===this._mapRequest&&serial===this._serial&&this.data.directory&&this.data.mode==='map';
    const {search,region,geo,countryCode}=this.data;
    const filters={scope:'public',spatial:'points',geo,countryCode,q:search,province:region[0],city:region[1],district:region[2]};
    const key=JSON.stringify(filters);
    const retained=key===this._mapKey?this._viewport:null;
    this._cluster=[];
    this.setData({mapLoading:true,mapError:'',pointCount:0,markers:[],center:null,selectedPoint:null,clusterRows:[],clusterTotal:0});
    try{
      const rows=new Map();
      let offset=0,more;
      do{
        const result=await api.collection('outlets',{...filters,limit:pointPageSize,offset,includeCountries:offset===0?'true':undefined});
        if(!current())return;
        if(Array.isArray(result.countries)){
          this.updateCountries(result.countries);
          this.setData({countriesLoaded:true});
        }
        for(const item of result.items){
          if(item.id&&mapView.coordinate(item,true))rows.set(item.id,publicRow(item));
        }
        more=result.hasMore;
        const next=result.offset+result.items.length;
        if(more&&next<=offset)throw new Error(mapError);
        offset=next;
        this.setData({pointCount:rows.size});
      }while(more);
      if(!current())return;
      this._pointRows=Array.from(rows.values());
      const viewport=retained||mapView.viewport(this._pointRows.map(point=>mapView.coordinate(point,true)));
      this._mapKey=key;
      this._viewport=viewport;
      this.renderMap(viewport);
    }catch{
      if(current())this.setData({mapError,markers:[],pointCount:0,center:null});
    }finally{
      if(current())this.setData({mapLoading:false});
    }
  },
  renderMap(viewport){
    const zoom=viewport?.scale||mapView.minScale;
    const markers=mapView.markers(this._pointRows||[],true,zoom,viewport?.lng,true);
    this.setData({center:viewport,zoom,markers});
  },
  resetViewport(){
    const viewport=mapView.viewport((this._pointRows||[]).map(point=>mapView.coordinate(point,true)));
    this._viewport=viewport;
    this.renderMap(viewport);
  },
  mapFailed(){
    if(this.data.mode==='map')this.setData({mapError:'当前微信地图暂不可显示，可查看下方网点地址。'});
  },
  async retryMap(){
    if(this.data.mode!=='map'||this.data.loading||this.data.mapLoading)return;
    if(this.data.directory)return this.loadPublicMap();
    this.setData({mapError:''});
    await this.refresh();
  },
  regionChanged(e){
    if(!this.data.directory||this.data.mapLoading||!this.data.center||
      (e.type!=='end'&&e.detail?.type!=='end')||
      !['gesture','drag','scale'].includes(e.causedBy||e.detail?.causedBy))return;
    const detail=e.detail||{};
    const center=detail.centerLocation||{};
    const previous=this._viewport||this.data.center;
    if(!Number.isFinite(center.latitude)||!Number.isFinite(center.longitude))return;
    const zoom=Number.isFinite(detail.scale)?detail.scale:previous.scale;
    this._viewport={lat:center.latitude,lng:center.longitude,scale:zoom};
    if(zoom!==previous.scale)this.setData({markers:mapView.markers(this._pointRows,true,zoom,center.longitude,true)});
  },
  marker(e){
    const point=this.data.markers.find(x=>x.id===Number(e.detail.markerId));
    if(!point)return;
    if(!this.data.directory||this.data.mode!=='map')return this.openOutlet(point.outletId);
    if(point.outletIds?.length>1){
      const ids=new Set(point.outletIds);
      this._cluster=this._pointRows.filter(row=>ids.has(row.id));
      this.setData({selectedPoint:null,clusterRows:this._cluster.slice(0,20),clusterTotal:this._cluster.length});
      return;
    }
    this.setData({selectedPoint:{id:point.outletId,name:point.title},clusterRows:[],clusterTotal:0});
  },
  moreCluster(){
    this.setData({clusterRows:this._cluster.slice(0,this.data.clusterRows.length+20)});
  },
  modeUnavailable(){
    this._mapRequest=(this._mapRequest||0)+1;
    this.setData({mode:'list',mapError:'',mapLoading:false,selectedPoint:null,clusterRows:[],clusterTotal:0});
    if(this.data.directory)this.loadOutletCovers();
  },
  open(e){this.openOutlet(e.currentTarget.dataset.id);},
  openFromPrivateList(page,query){
    const range={scope:this._rowScope,loaded:this.data.pagers.outlets?.loaded||0};
    go(page,query,()=>{this._returnRange=range;});
  },
  privateOutlet(id){
    const session=api.session();
    if(this.data.isPublic||this.data.directory||this.data.loading||this.data.error||
      session?.role!=='partner'||session.token!==this.data.session?.token)return;
    return this.data.rows.find(row=>row.id===id&&row.owner);
  },
  outletAction(e){
    const outlet=this.privateOutlet(e.currentTarget.dataset.id);
    if(!outlet?.nextAction)return;
    const {page,month,returnedVersionId}=outlet.nextAction;
    this.openFromPrivateList(page,api.query({outlet:outlet.id,month,id:returnedVersionId,
      edit:returnedVersionId?'returned':undefined}));
  },
  openOutlet(id){
    const directory=this.data.directory;
    if(!directory){
      const outlet=this.privateOutlet(id);
      if(outlet)this.openFromPrivateList('outlet',api.query({id:outlet.id}));
      return;
    }
    if(this.data.loading||this.data.error||
        !this.data.rows.some(row=>row.id===id)&&
        !(directory&&this.data.mode==='map'&&(this._pointRows||[]).some(row=>row.id===id)))return;
    const explicitPublic=directory&&(this.query.scope==='public'||!this.data.isPublic);
    go('outlet',api.query({id,scope:explicitPublic?'public':undefined}));
  }
});
const refresh=page.refresh;
page.refresh=async function(){
  const range=this._returnRange;
  this._returnRange=null;
  const retainingRows=this.data.mode==='list'&&this.data.hasLoaded&&this.data.rows.length>0&&
    this._rowScope===resultScope(this);
  const countScope=JSON.stringify([api.session()?.token||'',this.query?.scope,this.data.search,this.data.region]);
  if(countScope!==this._countScope){
    this._countScope=countScope;
    this.setData({statusCounts:null});
  }
  if(retainingRows!==this.data.retainingRows)this.setData({retainingRows});
  this._returning=range?{range,serial:(this._serial||0)+1}:null;
  this.updatePublicShareMenu();
  const pending=refresh.call(this);
  const serial=this._serial;
  try{
    await pending;
  }finally{
    if(serial===this._serial&&this.data.retainingRows)this.setData({retainingRows:false});
  }
};
Page(page);
