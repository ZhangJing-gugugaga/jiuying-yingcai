const {define,go,api,fmt}=require('../../utils/page');
const mapView=require('../../utils/outlet-map');

const geography=[
  {value:'all',label:'全域分布'},
  {value:'mainland',label:'中国大陆'},
  {value:'overseas',label:'境外'}
];
const allCountries={code:'',name:'全部国家或地区'};
const pointPageSize=200;
const mapError='暂时无法加载网点地图，请重试。仍可查看下方网点地址。';

const statusFilters=[{value:'all',label:'全部'},...['preparing','open','paused','closed'].map(value=>({value,label:fmt.label(value,'outlet')}))];
const summaries=[
  {key:'report',title:'经营月报',labels:{missing:'待填写',pending:'总部审核中',finance:'财务复核中',returned:'待我修改',approved:'已通过',revoked:'已撤销',exempt:'已免报',exemption_pending:'免报待审核',not_required:'本月无需报送'}},
  {key:'location',title:'位置核验',labels:{missing:'待提交位置资料',pending:'等待总部核验',approved:'位置已核验',exception:'位置待核实',not_required:'本月无需核验'}},
  {key:'fee',title:'咨询服务费',labels:{missing:'暂无账单',unpaid:'待支付',partially_paid:'部分支付',paid:'已支付',settled_zero:'已结清',reversed:'已冲正',mixed:'账单状态不同，请查看账单'}}
];
const settlementLabels={settled:'已结算',unsettled:'尚未结算'};

function summaryRows(summary){
  return summaries.flatMap(({key,title,labels})=>{
    const record=summary?.[key];
    const monthText=fmt.monthText(record?.month);
    if(!monthText)return [];
    const settlement=key==='report'?settlementLabels[record.settlementStatus]:'';
    return [{key,title,monthText,statusText:[labels[record.status]||'暂不可查看',settlement].filter(Boolean).join(' · ')}];
  });
}

function publicRow(outlet){
  const {id,name,address,status,city,countryCode,countryName,publicLocation,publicCoords}=outlet;
  const area=[countryName,city].filter((name,index,all)=>name&&all.indexOf(name)===index).join(' · ');
  return {id,name,address,area,countryCode,statusText:fmt.label(status,'outlet'),statusTone:fmt.statusTone(status,'outlet'),publicLocation,publicCoords};
}

Page(define({
  collections:[{
    name:'outlets',
    filters(){
      const directory=this.data.isPublic||this.query.scope==='public';
      const {search,region,statusFilter,geo,countryCode}=this.data;
      return {q:search,province:region[0],city:region[1],district:region[2],status:directory?'all':statusFilter,
        ...(directory?{scope:'public',geo,countryCode}:{includeSummary:'true'})};
    }
  }],
  data:{
    directory:false,search:'',region:[],statusFilter:'all',statusFilters,rows:[],mode:'list',
    geography,geo:'all',countryCode:'',availableCountries:[],countryChoices:[allCountries],countryIndex:0,
    markers:[],center:null,zoom:mapView.minScale,minScale:mapView.minScale,maxScale:mapView.maxScale,
    mapLoading:false,mapError:'',pointCount:0,selectedPoint:null,clusterRows:[],clusterTotal:0
  },
  load(q){
    if(q.scope==='public'||q.scope==='private')this.resetScope(this.data.isPublic||q.scope==='public');
    if(q.mode==='map')this.setData({mode:'map'});
  },
  async loaded(s){
    const directory=this.data.isPublic||this.query.scope==='public';
    const rows=directory?s.outlets.map(publicRow):s.outlets.map(outlet=>({...outlet,summaryRows:summaryRows(outlet.summary)}));
    this.setData({directory,rows});
    wx.setNavigationBarTitle?.({title:directory?'服务网点':'我的网点'});
    if(directory&&this.data.mode==='map'){
      if(this._mapSerial!==this._serial)await this.loadPublicMap();
      return;
    }
    const points=rows.map(row=>mapView.coordinate(row,directory)).filter(Boolean);
    const viewport=mapView.viewport(points);
    this.setData({markers:mapView.markers(rows,directory,viewport?.scale||mapView.minScale),
      center:viewport,zoom:viewport?.scale||mapView.minScale});
  },
  resetScope(directory){
    this._mapRequest=(this._mapRequest||0)+1;
    this._mapKey=null;
    this._mapSerial=null;
    this._viewport=null;
    this._pointRows=[];
    this._cluster=[];
    this.setData({directory,search:'',region:[],statusFilter:'all',mode:'list',rows:[],markers:[],center:null,
      geo:'all',countryCode:'',availableCountries:[],countryChoices:[allCountries],countryIndex:0,
      mapLoading:false,mapError:'',pointCount:0,selectedPoint:null,clusterRows:[],clusterTotal:0});
  },
  async changeScope(e){
    const {scope}=e.currentTarget.dataset;
    if(this.data.isPublic||!['public','private'].includes(scope)||this.data.directory===(scope==='public'))return;
    this.query={scope};
    this.resetScope(scope==='public');
    await this.refresh();
  },
  async search(e){this.setData({search:e.detail.value.trim()});await this.refresh();},
  async region(e){this.setData({region:e.detail.value,countryCode:''});this.updateCountries();await this.refresh();},
  async clearRegion(){this.setData({region:[]});await this.refresh();},
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
  async openCountries(){
    const serial=this._serial;
    try{
      const result=await api.collection('outlets',{scope:'public',includeCountries:'true',limit:1});
      if(serial===this._serial&&this.data.directory){
        this.updateCountries(result.countries||[]);
        if(this.data.countryChoices.length===1)wx.showToast?.({title:'当前范围暂无可筛选地区',icon:'none'});
      }
    }catch{
      if(serial===this._serial)wx.showToast?.({title:'暂时无法加载地区，请重试',icon:'none'});
    }
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
    if(!['list','map'].includes(mode)||mode===this.data.mode)return;
    this.setData({mode,mapError:'',selectedPoint:null,clusterRows:[],clusterTotal:0});
    if(mode==='map'&&this.data.directory)await this.loadPublicMap();
  },
  async loadPublicMap(){
    if(!this.data.directory||this.data.mode!=='map')return;
    const serial=this._serial;
    const request=(this._mapRequest||0)+1;
    this._mapRequest=request;
    this._mapSerial=serial;
    const current=()=>request===this._mapRequest&&serial===this._serial&&this.data.directory;
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
        if(Array.isArray(result.countries))this.updateCountries(result.countries);
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
    if(this.data.mode!=='map')return;
    this.setData({mapError:this.data.directory?'当前微信地图暂不可显示，可查看下方地区和网点地址。':'地图暂不可显示，可返回网点列表继续查看。'});
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
  modeUnavailable(){this.setData({mode:'list',mapError:''});},
  open(e){this.openOutlet(e.currentTarget.dataset.id);},
  openOutlet(id){
    const directory=this.data.directory;
    if(this.data.loading||this.data.error||
        !this.data.rows.some(row=>row.id===id)&&
        !(directory&&this.data.mode==='map'&&(this._pointRows||[]).some(row=>row.id===id)))return;
    go('outlet',api.query({id,scope:directory&&!this.data.isPublic?'public':undefined}));
  }
}));
