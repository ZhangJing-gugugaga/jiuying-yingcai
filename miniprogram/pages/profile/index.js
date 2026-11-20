const {define,api,go}=require('../../utils/page');
const {favorites,changeFavorite}=require('../../utils/public-outlet-preferences');

Page(define({
  collections:[{name:'accounts',visible(){return !this.data.isPublic;}}],
  data:{hasAccount:false,managerName:'',organizationName:'',outletCount:null,detailsUnavailable:false,
    version:'',showFavorites:false,favoriteRows:[],unavailableFavorites:0,favoritesLoading:false,favoritesError:''},
  load(){
    try{
      const version=wx.getAccountInfoSync?.().miniProgram?.version;
      if(typeof version==='string'&&/^\d+\.\d+\.\d+$/.test(version))this.setData({version});
    }catch{}
  },
  async loaded(state) {
    const account=state.accounts.find(item=>item.actor===state.actor);
    if(!account){
      this.setData({hasAccount:false,managerName:'',organizationName:'',outletCount:null,detailsUnavailable:false});
      if(this.data.showFavorites)await this.loadFavorites();
      return;
    }
    const serial=this._serial;
    this.setData({hasAccount:true,managerName:account.managerName||'',
      organizationName:'',outletCount:null,detailsUnavailable:false});
    const [organization,outlets]=await Promise.allSettled([
      api.detail('organizations',account.owner),
      api.collection('outlets',{limit:1})
    ]);
    if(serial!==this._serial)return;
    this.setData({
      organizationName:organization.value?.name||'',
      outletCount:outlets.value?.total??null,
      detailsUnavailable:organization.status==='rejected'||outlets.status==='rejected'
    });
    if(this.data.showFavorites)await this.loadFavorites();
  },
  toggleFavorites(){
    const showFavorites=!this.data.showFavorites;
    this.setData({showFavorites});
    if(showFavorites)return this.loadFavorites();
    this._favoriteRequest=(this._favoriteRequest||0)+1;
    this._unavailableFavorites=[];
    this.setData({favoriteRows:[],favoritesLoading:false,favoritesError:'',unavailableFavorites:0});
  },
  async loadFavorites(){
    if(!this.data.showFavorites)return;
    const request=(this._favoriteRequest||0)+1;
    this._favoriteRequest=request;
    const ids=favorites();
    const favoriteRows=[];
    const unavailable=[];
    let failed=0;
    this._unavailableFavorites=[];
    this.setData({favoriteRows:[],favoritesLoading:true,favoritesError:'',unavailableFavorites:0});
    for(let index=0;index<ids.length;index+=4){
      const batch=ids.slice(index,index+4);
      const results=await Promise.allSettled(batch.map(id=>api.detail('outlets',id,{scope:'public'})));
      if(request!==this._favoriteRequest)return;
      for(const [position,result] of results.entries()){
        if(result.status==='fulfilled'){
          const {id,name,address}=result.value;
          favoriteRows.push({id,name,address});
        }else if([403,404].includes(result.reason?.status))unavailable.push(batch[position]);
        else failed++;
      }
    }
    this._unavailableFavorites=unavailable;
    this.setData({favoriteRows,unavailableFavorites:unavailable.length,favoritesLoading:false,
      favoritesError:failed?'部分收藏暂时无法加载，请重试。':''});
  },
  openFavorite(e){
    const id=e.currentTarget.dataset.id;
    if(this.data.favoriteRows.some(item=>item.id===id))go('outlet',api.query({scope:'public',id}));
  },
  clearUnavailableFavorites(){
    if(this.data.favoritesLoading||!this.data.unavailableFavorites||this.data.favoritesError)return;
    try{
      for(const id of this._unavailableFavorites||[])changeFavorite(id,true);
      this._unavailableFavorites=[];
      this.setData({unavailableFavorites:0});
    }catch{
      this.setData({favoritesError:'暂时无法清理收藏，请重试。'});
    }
  },
  async privacy() {
    try {
      await api.privacyContract();
    } catch(e) {
      this.setData({error:e.message});
    }
  },
  logout() {
    wx.showModal({
      title:'退出登录',
      content:'确认退出当前账号吗？',
      success:result=>{if(result.confirm)api.logout();}
    });
  }
}));
