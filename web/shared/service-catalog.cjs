'use strict';
// 服务协议可声明的服务项。历史协议没有 services 字段时保持原有入口，不推断套餐。
const SERVICES={
 monthly_report:'经营月报',
 agency_reporting:'下级报送与催报',
 location_verification:'位置核验',
 service_fee:'服务费与账单',
 training:'培训资料',
 priority_support:'优先客服'
};
const codes=Object.keys(SERVICES);
module.exports={SERVICES,codes};