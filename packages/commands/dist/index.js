// src/dashboard/server.ts
import http from "node:http";

// src/dashboard/store-read.ts
import {
  SddScriptError,
  StoreError,
  queryDashboard,
  resolveExecutionReadRoute,
  withStoreRead
} from "@mstar-harness/engine";
var MAX_DASHBOARD_SEARCH_LENGTH = 200;
var DASHBOARD_API_VIEWS = {
  "/api/issues": "issues",
  "/api/issue-flow": "issue-flow",
  "/api/workflows": "workflows",
  "/api/iterations": "iterations",
  "/api/roadmap": "roadmap"
};
var DASHBOARD_DETAIL_VIEWS = {
  issues: "issue-detail",
  workflows: "workflow-detail",
  iterations: "iteration-detail"
};
var VIEW_QUERY_FIELDS = {
  issues: ["project", "disposition", "kind", "severity", "q", "limit", "offset"],
  "issue-detail": [],
  workflows: ["project", "limit", "offset"],
  "workflow-detail": [],
  iterations: ["project", "limit", "offset"],
  "iteration-detail": [],
  roadmap: ["project"],
  "issue-flow": ["project"]
};
var DISPOSITIONS = { open: true, resolved: true, waived: true, duplicate: true, superseded: true };
var KINDS = {
  bug: true,
  risk: true,
  improvement: true,
  request: true,
  decision: true,
  "review-obligation": true
};
var SEVERITIES = { critical: true, high: true, medium: true, low: true, info: true };
function refuse(message) {
  throw new SddScriptError(message, 2);
}
function requireSafeId(label, value) {
  if (value === "" || value === "." || value === ".." || /[/\\\u0000]/.test(value)) {
    refuse(`${label} must be a single safe id`);
  }
  return value;
}
function resolveDashboardRoute(pathname) {
  const exact = DASHBOARD_API_VIEWS[pathname];
  if (exact !== undefined)
    return { view: exact };
  const segments = pathname.split("/");
  if (segments.length !== 4 || segments[1] !== "api" || segments[3] === "")
    return null;
  const detail = DASHBOARD_DETAIL_VIEWS[segments[2]];
  if (detail === undefined)
    return null;
  let id;
  try {
    id = decodeURIComponent(segments[3]);
  } catch {
    refuse(`path segment ${JSON.stringify(segments[3])} is not valid percent-encoding`);
  }
  return { view: detail, id: requireSafeId("the detail id", id) };
}
function queryValue(params, field) {
  const value = params[field];
  if (value === undefined || value === "")
    return;
  return value;
}
function parsePageInteger(raw, field, max) {
  if (raw === undefined)
    return;
  if (!/^[0-9]+$/.test(raw))
    refuse(`${field} must be a nonnegative integer`);
  const value = Number(raw);
  if (max !== undefined && (value < 1 || value > max))
    refuse(`${field} must be an integer between 1 and ${max}`);
  return value;
}
function dashboardFilters(view, params = {}, id) {
  const accepted = VIEW_QUERY_FIELDS[view];
  if (!Array.isArray(accepted))
    refuse(`unknown dashboard view ${JSON.stringify(String(view))}`);
  for (const field of Object.keys(params)) {
    if (!accepted.includes(field))
      refuse(`${JSON.stringify(field)} is not a supported ${view} query parameter`);
  }
  const limit = parsePageInteger(queryValue(params, "limit"), "limit", 200);
  const offset = parsePageInteger(queryValue(params, "offset"), "offset");
  const project = queryValue(params, "project");
  const scoped = project === undefined ? undefined : requireSafeId("project", project);
  if (view === "issues") {
    const disposition = queryValue(params, "disposition");
    if (disposition !== undefined && DISPOSITIONS[disposition] !== true) {
      refuse(`disposition must be one of ${Object.keys(DISPOSITIONS).join(", ")}`);
    }
    const kind = queryValue(params, "kind");
    if (kind !== undefined && KINDS[kind] !== true)
      refuse(`kind must be one of ${Object.keys(KINDS).join(", ")}`);
    const severity = queryValue(params, "severity");
    if (severity !== undefined && SEVERITIES[severity] !== true) {
      refuse(`severity must be one of ${Object.keys(SEVERITIES).join(", ")}`);
    }
    const search = queryValue(params, "q");
    if (search !== undefined && search.length > MAX_DASHBOARD_SEARCH_LENGTH) {
      refuse(`q must be at most ${MAX_DASHBOARD_SEARCH_LENGTH} characters`);
    }
    const issue = {
      ...scoped === undefined ? {} : { projectId: scoped },
      ...disposition === undefined ? {} : { disposition },
      ...kind === undefined ? {} : { kind },
      ...severity === undefined ? {} : { severity },
      ...search === undefined ? {} : { query: search },
      ...limit === undefined ? {} : { limit },
      ...offset === undefined ? {} : { offset }
    };
    return { issue };
  }
  if (view === "issue-detail" || view === "workflow-detail" || view === "iteration-detail") {
    if (id === undefined)
      refuse(`the ${view} route requires an id`);
    return { id: requireSafeId(`${view} id`, id) };
  }
  if (view === "roadmap" && scoped === undefined) {
    refuse("the roadmap view requires a project query parameter");
  }
  return {
    ...scoped === undefined ? {} : { projectId: scoped },
    ...limit === undefined ? {} : { limit },
    ...offset === undefined ? {} : { offset }
  };
}
async function readDashboardView(input) {
  const filters = dashboardFilters(input.view, input.params ?? {}, input.id);
  const query = queryDashboard(input.view, filters);
  if (query.needsProjection && await resolveExecutionReadRoute(input.context) === "execution") {
    throw new StoreError("execution.consumer-not-ready", `The execution authority of ${input.context.harnessDir} is ACTIVE, so the "${input.view}" view's projection ` + `sources (the root register and the workflow snapshots) are retired. Nothing was read: this view is answered ` + `by the DB authority once its DTO projection lands, and the engine adapter serves workflow/plan state today.`);
  }
  return withStoreRead(input.context, query);
}
function dashboardFailure(error) {
  if (error instanceof SddScriptError)
    return { code: "usage", message: error.message };
  const code = error?.code;
  if (typeof code === "string" && code !== "") {
    return { code, message: error instanceof Error ? error.message : String(error) };
  }
  return { code: "internal-error", message: error instanceof Error ? error.message : String(error) };
}

// src/dashboard/assets.generated.ts
var dashboardHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>Morning Star Dashboard</title>
    <link rel="stylesheet" href="/assets/app.css" />
  </head>
  <body>
    <div id="app"></div>
    <noscript>Morning Star Dashboard requires JavaScript.</noscript>
    <script src="/assets/app.js"></script>
  </body>
</html>
`;
var dashboardJs = 'var ce,v,qe,Bt,H,Be,Ge,Qe,ke,se,ee,ze,Ce,xe,Ie,Mt,ae={},ie=[],Vt=/acit|ex(?:s|g|n|p|$)|rph|grid|ows|mnc|ntw|ine[ch]|zoo|^ord|itera/i,ue=Array.isArray;function F(t,e){for(var n in e)t[n]=e[n];return t}function De(t){t&&t.parentNode&&t.parentNode.removeChild(t)}function de(t,e,n){var o,r,s,i={};for(s in e)s=="key"?o=e[s]:s=="ref"?r=e[s]:i[s]=e[s];if(arguments.length>2&&(i.children=arguments.length>3?ce.call(arguments,2):n),typeof t=="function"&&t.defaultProps!=null)for(s in t.defaultProps)i[s]===void 0&&(i[s]=t.defaultProps[s]);return re(t,i,o,r,null)}function re(t,e,n,o,r){var s={type:t,props:e,key:n,ref:o,__k:null,__:null,__b:0,__e:null,__c:null,constructor:void 0,__v:r==null?++qe:r,__i:-1,__u:0};return r==null&&v.vnode!=null&&v.vnode(s),s}function pe(t){return t.children}function G(t,e){this.props=t,this.context=e}function V(t,e){if(e==null)return t.__?V(t.__,t.__i+1):null;for(var n;e<t.__k.length;e++)if((n=t.__k[e])!=null&&n.__e!=null)return n.__e;return typeof t.type=="function"?V(t):null}function Kt(t){if(t.__P&&t.__d){var e=t.__v,n=e.__e,o=[],r=[],s=F({},e);s.__v=e.__v+1,v.vnode&&v.vnode(s),Se(t.__P,s,e,t.__n,t.__P.namespaceURI,32&e.__u?[n]:null,o,n==null?V(e):n,!!(32&e.__u),r),s.__v=e.__v,s.__.__k[s.__i]=s,et(o,s,r),e.__e=e.__=null,s.__e!=n&&Je(s)}}function Je(t){if((t=t.__)!=null&&t.__c!=null)return t.__e=t.__c.base=null,t.__k.some(function(e){if(e!=null&&e.__e!=null)return t.__e=t.__c.base=e.__e}),Je(t)}function Me(t){(!t.__d&&(t.__d=!0)&&H.push(t)&&!le.__r++||Be!=v.debounceRendering)&&((Be=v.debounceRendering)||Ge)(le)}function le(){try{for(var t,e=1;H.length;)H.length>e&&H.sort(Qe),t=H.shift(),e=H.length,Kt(t)}finally{H.length=le.__r=0}}function Ze(t,e,n,o,r,s,i,d,u,p,h){var g,c,f,y,S,I,P=o&&o.__k||ie,b=e.length;for(u=qt(n,e,P,u,b),g=0;g<b;g++)(f=n.__k[g])!=null&&(c=f.__i!=-1&&P[f.__i]||ae,f.__i=g,I=Se(t,f,c,r,s,i,d,u,p,h),y=f.__e,f.ref&&c.ref!=f.ref&&(c.ref&&Pe(c.ref,null,f),h.push(f.ref,f.__c||y,f)),S==null&&y!=null&&(S=y),4&f.__u?(u=Ye(f,u,t),c.__e&&(c.__e=null)):typeof f.type=="function"&&I!==void 0?u=I:y&&(u=y.nextSibling),f.__u&=-7);return n.__e=S,u}function qt(t,e,n,o,r){var s,i,d,u,p,h=n.length,g=h,c=0;for(t.__k=Array(r),s=0;s<r;s++)(i=e[s])!=null&&typeof i!="boolean"&&typeof i!="function"?(typeof i=="string"||typeof i=="number"||typeof i=="bigint"||i.constructor==String?i=t.__k[s]=re(null,i,null,null,null):ue(i)?i=t.__k[s]=re(pe,{children:i},null,null,null):i.constructor===void 0&&i.__b>0?i=t.__k[s]=re(i.type,i.props,i.key,i.ref?i.ref:null,i.__v):t.__k[s]=i,u=s+c,i.__=t,i.__b=t.__b+1,d=null,(p=i.__i=Gt(i,n,u,g))!=-1&&(g--,(d=n[p])&&(d.__u|=2)),d==null||d.__v==null?(p==-1&&(r>h?c--:r<h&&c++),typeof i.type!="function"&&(i.__u|=4)):p!=u&&(p==u-1?c--:p==u+1?c++:(p>u?c--:c++,i.__u|=4))):t.__k[s]=null;if(g)for(s=0;s<h;s++)(d=n[s])!=null&&(2&d.__u)==0&&(d.__e==o&&(o=V(d)),nt(d,d));return o}function Ye(t,e,n){var o,r;if(typeof t.type=="function"){for(o=t.__k,r=0;o&&r<o.length;r++)o[r]&&(o[r].__=t,e=Ye(o[r],e,n));return e}t.__e!=e&&(e&&t.type&&!e.parentNode&&(e=V(t)),e=n.insertBefore(t.__e,e||null));do e=e&&e.nextSibling;while(e!=null&&e.nodeType==8);return e}function Gt(t,e,n,o){var r,s,i,d=t.key,u=t.type,p=e[n],h=p!=null&&(2&p.__u)==0;if(p===null&&d==null||h&&d==p.key&&u==p.type)return n;if(o>(h?1:0)){for(r=n-1,s=n+1;r>=0||s<e.length;)if((p=e[i=r>=0?r--:s++])!=null&&(2&p.__u)==0&&d==p.key&&u==p.type)return i}return-1}function Ve(t,e,n){e[0]=="-"?t.setProperty(e,n==null?"":n):t[e]=n==null?"":typeof n!="number"||Vt.test(e)?n:n+"px"}function oe(t,e,n,o,r){var s,i;e:if(e=="style")if(typeof n=="string")t.style.cssText=n;else{if(typeof o=="string"&&(t.style.cssText=o=""),o)for(e in o)n&&e in n||Ve(t.style,e,"");if(n)for(e in n)o&&n[e]==o[e]||Ve(t.style,e,n[e])}else if(e[0]=="o"&&e[1]=="n")s=e!=(e=e.replace(ze,"$1")),i=e.toLowerCase(),e=i in t||e=="onFocusOut"||e=="onFocusIn"?i.slice(2):e.slice(2),t.l||(t.l={}),t.l[e+s]=n,n?o?n[ee]=o[ee]:(n[ee]=Ce,t.addEventListener(e,s?Ie:xe,s)):t.removeEventListener(e,s?Ie:xe,s);else{if(r=="http://www.w3.org/2000/svg")e=e.replace(/xlink(H|:h)/,"h").replace(/sName$/,"s");else if(e!="width"&&e!="height"&&e!="href"&&e!="list"&&e!="form"&&e!="tabIndex"&&e!="download"&&e!="rowSpan"&&e!="colSpan"&&e!="role"&&e!="popover"&&e in t)try{t[e]=n==null?"":n;break e}catch(d){}typeof n=="function"||(n==null||n===!1&&e[4]!="-"?t.removeAttribute(e):t.setAttribute(e,e=="popover"&&n==1?"":n))}}function Ke(t){return function(e){if(this.l){var n=this.l[e.type+t];if(e[se]==null)e[se]=Ce++;else if(e[se]<n[ee])return;return n(v.event?v.event(e):e)}}}function Se(t,e,n,o,r,s,i,d,u,p){var h,g,c,f,y,S,I,P,b,N,Y,M,X,We,ne,ve,O=e.type;if(e.constructor!==void 0)return null;128&n.__u&&(u=!!(32&n.__u),s=[d=e.__e=n.__e]),(h=v.__b)&&h(e);e:if(typeof O=="function"){g=i.length;try{if(b=e.props,N=O.prototype&&O.prototype.render,Y=(h=O.contextType)&&o[h.__c],M=h?Y?Y.props.value:h.__:o,n.__c?P=(c=e.__c=n.__c).__=c.__E:(N?e.__c=c=new O(b,M):(e.__c=c=new G(b,M),c.constructor=O,c.render=zt),Y&&Y.sub(c),c.state||(c.state={}),c.__n=o,f=c.__d=!0,c.__h=[],c._sb=[]),N&&c.__s==null&&(c.__s=c.state),N&&O.getDerivedStateFromProps!=null&&(c.__s==c.state&&(c.__s=F({},c.__s)),F(c.__s,O.getDerivedStateFromProps(b,c.__s))),y=c.props,S=c.state,c.__v=e,f)N&&O.getDerivedStateFromProps==null&&c.componentWillMount!=null&&c.componentWillMount(),N&&c.componentDidMount!=null&&c.__h.push(c.componentDidMount);else{if(N&&O.getDerivedStateFromProps==null&&b!==y&&c.componentWillReceiveProps!=null&&c.componentWillReceiveProps(b,M),e.__v==n.__v||!c.__e&&c.shouldComponentUpdate!=null&&c.shouldComponentUpdate(b,c.__s,M)===!1){e.__v!=n.__v&&(c.props=b,c.state=c.__s,c.__d=!1),e.__e=n.__e,e.__k=n.__k,e.__k.some(function(q){q&&(q.__=e)}),ie.push.apply(c.__h,c._sb),c._sb=[],c.__h.length&&i.push(c),d=V(n);break e}c.componentWillUpdate!=null&&c.componentWillUpdate(b,c.__s,M),N&&c.componentDidUpdate!=null&&c.__h.push(function(){c.componentDidUpdate(y,S,I)})}if(c.context=M,c.props=b,c.__P=t,c.__e=!1,X=v.__r,We=0,N)c.state=c.__s,c.__d=!1,X&&X(e),h=c.render(c.props,c.state,c.context),ie.push.apply(c.__h,c._sb),c._sb=[];else do c.__d=!1,X&&X(e),h=c.render(c.props,c.state,c.context),c.state=c.__s;while(c.__d&&++We<25);c.state=c.__s,c.getChildContext!=null&&(o=F(F({},o),c.getChildContext())),N&&!f&&c.getSnapshotBeforeUpdate!=null&&(I=c.getSnapshotBeforeUpdate(y,S)),ne=h!=null&&h.type===pe&&h.key==null?tt(h.props.children):h,d=Ze(t,ue(ne)?ne:[ne],e,n,o,r,s,i,d,u,p),c.base=e.__e,e.__u&=-161,c.__h.length&&i.push(c),P&&(c.__E=c.__=null)}catch(q){if(i.length=g,e.__v=null,u||s!=null){if(q.then){for(e.__u|=u?160:128;d&&d.nodeType==8&&d.nextSibling;)d=d.nextSibling;s!=null&&(s[s.indexOf(d)]=null),e.__e=d}else if(s!=null)for(ve=s.length;ve--;)De(s[ve])}else e.__e=n.__e;e.__k==null&&(e.__k=n.__k||[]),q.then||Xe(e),v.__e(q,e,n)}}else s==null&&e.__v==n.__v?(e.__k=n.__k,e.__e=n.__e):d=e.__e=Qt(n.__e,e,n,o,r,s,i,u,p);return(h=v.diffed)&&h(e),128&e.__u?void 0:d}function Xe(t){t&&(t.__c&&(t.__c.__e=!0),t.__k&&t.__k.some(Xe))}function et(t,e,n){for(var o=0;o<n.length;o++)Pe(n[o],n[++o],n[++o]);v.__c&&v.__c(e,t),t.some(function(r){try{t=r.__h,r.__h=[],t.some(function(s){s.call(r)})}catch(s){v.__e(s,r.__v)}})}function tt(t){return typeof t!="object"||t==null||t.__b>0?t:ue(t)?t.map(tt):t.constructor!==void 0?null:F({},t)}function Qt(t,e,n,o,r,s,i,d,u){var p,h,g,c,f,y,S,I=n.props||ae,P=e.props,b=e.type;if(b=="svg"?r="http://www.w3.org/2000/svg":b=="math"?r="http://www.w3.org/1998/Math/MathML":r||(r="http://www.w3.org/1999/xhtml"),s!=null){for(p=0;p<s.length;p++)if((f=s[p])&&"setAttribute"in f==!!b&&(b?f.localName==b:f.nodeType==3)){t=f,s[p]=null;break}}if(t==null){if(b==null)return document.createTextNode(P);t=document.createElementNS(r,b,P.is&&P),d&&(v.__m&&v.__m(e,s),d=!1),s=null}if(b==null)I===P||d&&t.data==P||(t.data=P);else{if(s=b=="textarea"&&P.defaultValue!=null?null:s&&ce.call(t.childNodes),!d&&s!=null)for(I={},p=0;p<t.attributes.length;p++)I[(f=t.attributes[p]).name]=f.value;for(p in I)f=I[p],p=="dangerouslySetInnerHTML"?g=f:p=="children"||(p in P)||p=="value"&&("defaultValue"in P)||p=="checked"&&("defaultChecked"in P)||oe(t,p,null,f,r);for(p in P)f=P[p],p=="children"?c=f:p=="dangerouslySetInnerHTML"?h=f:p=="value"?y=f:p=="checked"?S=f:d&&typeof f!="function"||I[p]===f||oe(t,p,f,I[p],r);if(h)d||g&&(h.__html==g.__html||h.__html==t.innerHTML)||(t.innerHTML=h.__html),e.__k=[];else if(g&&(t.innerHTML=""),Ze(e.type=="template"?t.content:t,ue(c)?c:[c],e,n,o,b=="foreignObject"?"http://www.w3.org/1999/xhtml":r,s,i,s?s[0]:n.__k&&V(n,0),d,u),s!=null)for(p=s.length;p--;)De(s[p]);d&&b!="textarea"||(p="value",b=="progress"&&y==null?t.removeAttribute("value"):y!=null&&(y!==t[p]||b=="progress"&&!y||b=="option"&&y!=I[p])&&oe(t,p,y,I[p],r),p="checked",S!=null&&S!=t[p]&&oe(t,p,S,I[p],r))}return t}function Pe(t,e,n){try{if(typeof t=="function"){var o=typeof t.__u=="function";o&&t.__u(),o&&e==null||(t.__u=t(e))}else t.current=e}catch(r){v.__e(r,n)}}function nt(t,e,n){var o,r;if(v.unmount&&v.unmount(t),(o=t.ref)&&(o.current&&o.current!=t.__e||Pe(o,null,e)),(o=t.__c)!=null){if(o.componentWillUnmount)try{o.componentWillUnmount()}catch(s){v.__e(s,e)}o.base=o.__P=o.__n=null}if(o=t.__k)for(r=0;r<o.length;r++)o[r]&&nt(o[r],e,n||typeof t.type!="function");n||De(t.__e),t.__c=t.__=t.__e=void 0}function zt(t,e,n){return this.constructor(t,n)}function fe(t,e,n){var o,r,s,i;e==document&&(e=document.documentElement),v.__&&v.__(t,e),r=(o=typeof n=="function")?null:n&&n.__k||e.__k,s=[],i=[],Se(e,t=(!o&&n||e).__k=de(pe,null,[t]),r||ae,ae,e.namespaceURI,!o&&n?[n]:r?null:e.firstChild?ce.call(e.childNodes):null,s,!o&&n?n:r?r.__e:e.firstChild,o,i),et(s,t,i),t.props.children=null}ce=ie.slice,v={__e:function(t,e,n,o){for(var r,s,i;e=e.__;)if((r=e.__c)&&!r.__)try{if((s=r.constructor)&&s.getDerivedStateFromError!=null&&(r.setState(s.getDerivedStateFromError(t)),i=r.__d),r.componentDidCatch!=null&&(r.componentDidCatch(t,o||{}),i=r.__d),i)return r.__E=r}catch(d){t=d}throw t}},qe=0,Bt=function(t){return t!=null&&t.constructor===void 0},G.prototype.setState=function(t,e){var n;n=this.__s!=null&&this.__s!=this.state?this.__s:this.__s=F({},this.state),typeof t=="function"&&(t=t(F({},n),this.props)),t&&F(n,t),t!=null&&this.__v&&(e&&this._sb.push(e),Me(this))},G.prototype.forceUpdate=function(t){this.__v&&(this.__e=!0,t&&this.__h.push(t),Me(this))},G.prototype.render=pe,H=[],Ge=typeof Promise=="function"?Promise.prototype.then.bind(Promise.resolve()):setTimeout,Qe=function(t,e){return t.__v.__b-e.__v.__b},le.__r=0,ke=Math.random().toString(8),se="__d"+ke,ee="__a"+ke,ze=/(PointerCapture)$|Capture$/i,Ce=0,xe=Ke(!1),Ie=Ke(!0),Mt=0;var st=function(t,e,n,o){var r;e[0]=0;for(var s=1;s<e.length;s++){var i=e[s++],d=e[s]?(e[0]|=i?1:2,n[e[s++]]):e[++s];i===3?o[0]=d:i===4?o[1]=Object.assign(o[1]||{},d):i===5?(o[1]=o[1]||{})[e[++s]]=d:i===6?o[1][e[++s]]+=d+"":i?(r=t.apply(d,st(t,d,n,["",null])),o.push(r),d[0]?e[0]|=2:(e[s-2]=0,e[s]=r)):o.push(d)}return o},ot=new Map;function Te(t){var e=ot.get(this);return e||(e=new Map,ot.set(this,e)),(e=st(this,e.get(t)||(e.set(t,e=function(n){for(var o,r,s=1,i="",d="",u=[0],p=function(c){s===1&&(c||(i=i.replace(/^\\s*\\n\\s*|\\s*\\n\\s*$/g,"")))?u.push(0,c,i):s===3&&(c||i)?(u.push(3,c,i),s=2):s===2&&i==="..."&&c?u.push(4,c,0):s===2&&i&&!c?u.push(5,0,!0,i):s>=5&&((i||!c&&s===5)&&(u.push(s,0,i,r),s=6),c&&(u.push(s,c,0,r),s=6)),i=""},h=0;h<n.length;h++){h&&(s===1&&p(),p(h));for(var g=0;g<n[h].length;g++)o=n[h][g],s===1?o==="<"?(p(),u=[u],s=3):i+=o:s===4?i==="--"&&o===">"?(s=1,i=""):i=o+i[0]:d?o===d?d="":i+=o:o===\'"\'||o==="\'"?d=o:o===">"?(p(),s=1):s&&(o==="="?(s=5,r=i,i=""):o==="/"&&(s<5||n[h][g+1]===">")?(p(),s===3&&(u=u[0]),s=u,(u=u[0]).push(2,0,s),s=0):o===" "||o==="\\t"||o===`\n`||o==="\\r"?(p(),s=2):i+=o),s===3&&i==="!--"&&(s=4,u=u[0])}return p(),u}(t)),e),arguments,[])).length>1?e:e[0]}var a=Te.bind(de);var te,x,je,rt,he=0,ft=[],C=v,at=C.__b,it=C.__r,lt=C.diffed,ct=C.__c,ut=C.unmount,dt=C.__;function Le(t,e){C.__h&&C.__h(x,t,he||e),he=0;var n=x.__H||(x.__H={__:[],__h:[]});return t>=n.__.length&&n.__.push({}),n.__[t]}function A(t){return he=1,Jt(mt,t)}function Jt(t,e,n){var o=Le(te++,2);if(o.t=t,!o.__c&&(o.__=[n?n(e):mt(void 0,e),function(d){var u=o.__N?o.__N[0]:o.__[0],p=o.t(u,d);u!==p&&(o.__N=[p,o.__[1]],o.__c.setState({}))}],o.__c=x,!x.__f)){var r=function(d,u,p){if(!o.__c.__H)return!0;var h=!1,g=o.__c.props!==d;if(o.__c.__H.__.some(function(f){if(f.__N){h=!0;var y=f.__[0];f.__=f.__N,f.__N=void 0,y!==f.__[0]&&(g=!0)}}),s){var c=s.call(this,d,u,p);return h?c||g:c}return!h||g};x.__f=!0;var{shouldComponentUpdate:s,componentWillUpdate:i}=x;x.componentWillUpdate=function(d,u,p){if(this.__e){var h=s;s=void 0,r(d,u,p),s=h}i&&i.call(this,d,u,p)},x.shouldComponentUpdate=r}return o.__N||o.__}function R(t,e){var n=Le(te++,3);!C.__s&&ht(n.__H,e)&&(n.__=t,n.u=e,x.__H.__h.push(n))}function $t(t){return he=5,Zt(function(){return{current:t}},[])}function Zt(t,e){var n=Le(te++,7);return ht(n.__H,e)&&(n.__=t(),n.__H=e,n.__h=t),n.__}function Yt(){for(var t;t=ft.shift();){var e=t.__H;if(t.__P&&e)try{e.__h.some($e),e.__h.some(Ee),e.__h=[]}catch(n){e.__h=[],C.__e(n,t.__v)}}}C.__b=function(t){x=null,at&&at(t)},C.__=function(t,e){t&&e.__k&&e.__k.__m&&(t.__m=e.__k.__m),dt&&dt(t,e)},C.__r=function(t){it&&it(t),te=0;var e=(x=t.__c).__H;e&&(je===x?(e.__h=[],x.__h=[],e.__.some(function(n){n.__N&&(n.__=n.__N),n.u=n.__N=void 0})):(e.__h.some($e),e.__h.some(Ee),e.__h=[],te=0)),je=x},C.diffed=function(t){lt&&lt(t);var e=t.__c;e&&e.__H&&(e.__H.__h.length&&(ft.push(e)!==1&&rt===C.requestAnimationFrame||((rt=C.requestAnimationFrame)||Xt)(Yt)),e.__H.__.some(function(n){n.u&&(n.__H=n.u,n.u=void 0)})),je=x=null},C.__c=function(t,e){e.some(function(n){try{n.__h.some($e),n.__h=n.__h.filter(function(o){return!o.__||Ee(o)})}catch(o){e.some(function(r){r.__h&&(r.__h=[])}),e=[],C.__e(o,n.__v)}}),ct&&ct(t,e)},C.unmount=function(t){ut&&ut(t);var e,n=t.__c;n&&n.__H&&(n.__H.__.some(function(o){try{$e(o)}catch(r){e=r}}),n.__H=void 0,e&&C.__e(e,n.__v))};var pt=typeof requestAnimationFrame=="function";function Xt(t){var e,n=function(){clearTimeout(o),pt&&cancelAnimationFrame(e),setTimeout(t)},o=setTimeout(n,35);pt&&(e=requestAnimationFrame(n))}function $e(t){var e=x,n=t.__c;typeof n=="function"&&(t.__c=void 0,n()),x=e}function Ee(t){var e=x;t.__c=t.__(),x=e}function ht(t,e){return!t||t.length!==e.length||e.some(function(n,o){return n!==t[o]})}function mt(t,e){return typeof e=="function"?e(t):e}function D(t){let e=typeof t==="string"?t.trim():"";return e===""?"Date unknown":e}function Re(t){return t==="critical"||t==="high"?"danger":"neutral"}function Ne(t){if(t==="resolved")return"success";if(t==="open")return"neutral";return"terminal"}function me(t){let e=t.find((s)=>s.kind==="migration"||s.legacyEntryId!==null||s.legacyBucket!==null||s.legacyProject!==null);if(e===void 0)return null;let n=[e.legacyProject,e.legacyBucket].filter((s)=>s!==null&&s!=="").join(" / "),o=e.legacyEntryId===null||e.legacyEntryId===""?"":` #${e.legacyEntryId}`,r=n===""&&o===""?"":` (${n}${o})`;return`Imported from ${e.target}${r}`}function _t(t){if(typeof t!=="string"||t==="")return null;try{let e=new URL(t);return e.protocol==="http:"||e.protocol==="https:"?e.href:null}catch{return null}}function gt(t){if(t===null||t===void 0)return null;if(typeof t==="string")return t===""?null:t;let e=JSON.stringify(t,null,2);return e===void 0||e==="{}"||e==="[]"?null:e}function yt(t,e){if(t==="store.not-initialized")return`${e} — initialize the issue store with the CLI, then reload.`;if(t==="store.not-active")return`${e} — the store is staged, not active; complete the CLI activation, then reload.`;if(t.startsWith("store.")||t.startsWith("projection."))return`${e} — fix the store state with the CLI, then reload.`;return`${e} (${t})`}var wt={status:"loading",envelope:null,message:null},bt=1e4,en=`The dashboard did not answer within ${bt/1000} seconds. The local server may be stuck on an earlier read; reload to try again.`;function tn(t,e){let n=t?.error,o=typeof n?.code==="string"?n.code:"internal-error",r=typeof n?.message==="string"?n.message:`The dashboard request failed with HTTP ${e}.`;return yt(o,r)}function nn(t){return typeof t==="object"&&t!==null&&Object.hasOwn(t,"data")}function E(t){let[e,n]=A(wt);return R(()=>{if(t===null)return;let o=new AbortController,r=!0;n(wt);let s=setTimeout(()=>{if(!r)return;r=!1,o.abort(),n({status:"error",envelope:null,message:en})},bt);return(async()=>{try{let i=await fetch(t,{headers:{accept:"application/json"},signal:o.signal}),d=await i.json().catch(()=>null);if(!r)return;clearTimeout(s),n(i.ok&&nn(d)?{status:"ready",envelope:d,message:null}:{status:"error",envelope:null,message:tn(d,i.status)})}catch{if(!r)return;clearTimeout(s),n({status:"error",envelope:null,message:"The dashboard could not reach its local server. Check that the dashboard is running, then reload."})}})(),()=>{r=!1,clearTimeout(s),o.abort()}},[t]),e}function l(t){return a`<div class="fact">\n    <dt class="fact-label">${t.label}</dt>\n    <dd class="fact-value">${t.children}</dd>\n  </div>`}function m(t){return a`<section class="detail-section">\n    <h2 class="heading-20">${t.title}</h2>\n    ${t.children}\n  </section>`}function _(t){return a`<span class="badge" data-tone=${t.tone}>${t.children}</span>`}function w(t){return a`<div class="notice" data-tone=${t.tone}>${t.children}</div>`}function k(t){return a`<div class="empty-state">${t.children}</div>`}function j(t){return a`<p class="visually-hidden" role="status" aria-live="polite">${t.message}</p>`}function z(t){return t.generation===null}function J(t){if(t.freshness==="current")return null;return{freshness:t.freshness,diagnostics:t.diagnostics,builtAt:t.builtAt,checkedAt:t.checkedAt}}function on(t){let e=[t.freshness==="stale"?"Execution data is stale: the last successful projection is retained.":"Execution data is unavailable: no valid projection has been published yet."];if(t.diagnostics.length===0)e.push("No source diagnostic was recorded for this state.");else for(let n of t.diagnostics)e.push(`Source ${n.sourceKey}: ${n.reason} — ${n.message}`);return e.push(t.builtAt===null?"Last successful build: none recorded.":`Last successful build: ${t.builtAt}.`),e.push(t.checkedAt===""?"Last checked: unknown.":`Last checked: ${t.checkedAt}.`),e}function K(t){let e=t.disclosure;return a`<${w} tone=${e.freshness==="stale"?"warning":"error"}>\n    ${on(e).map((n,o)=>a`<p class="notice-line" key=${o}>${n}</p>`)}\n  </${w}>`}var sn={"catalog-missing":"No catalog row","catalog-pin-missing":"Prepared pin missing","catalog-pin-conflict":"Prepared pin differs from the catalog revision","execution-unavailable":"No execution data"};function rn(t){return t.map((e)=>sn[e])}function U(t){if(t.badges.length===0)return null;return a`<p class="badges">\n    ${rn(t.badges).map((e,n)=>a`<${_} key=${n} tone="warning">${e}</${_}>`)}\n  </p>`}function W(t){return t==="active"?"neutral":"terminal"}function Z(t){let e=t.catalog;return a`<dl class="facts">\n    <${l} label="Catalog title">${e.title}</${l}>\n    ${e.description===null?null:a`<${l} label="Catalog description"><span class="prose">${e.description}</span></${l}>`}\n    <${l} label="Catalog location"\n      ><span class="mono">${`${e.rootKind}:${e.relativePath}`}</span></${l}\n    >\n    <${l} label="Catalog lifecycle"\n      ><${_} tone=${W(e.lifecycle)}>${e.lifecycle}</${_}></${l}\n    >\n    <${l} label="Catalog revision"><span class="mono">${String(e.revision)}</span></${l}>\n    <${l} label="Catalog updated"><span class="mono">${e.updatedAt}</span></${l}>\n  </dl>`}function _e(t,e){if(t===null)return{kind:"missing"};if(e!==null&&e!==t)return{kind:"conflict",pin:t,current:e};return{kind:"pinned",revision:t}}function ge(t){switch(t.kind){case"missing":return"Prepared pin missing: this execution row records no catalog revision, so no prepared input is confirmed.";case"conflict":return`Prepared pin conflict: prepared at catalog revision ${t.pin}, the catalog row is now revision ${t.current}.`;case"pinned":return`Prepared pin: this execution row was prepared at catalog revision ${t.revision}.`}}function T(t){return t===null||t.trim()===""?"Not recorded":t}var Q=50;function ye(t){return a`<div class="pager">\n    <button\n      type="button"\n      class="button-secondary"\n      disabled=${t.offset===0}\n      onClick=${()=>t.onChange(Math.max(0,t.offset-Q))}\n    >\n      Previous\n    </button>\n    <p class="pager-summary">\n      Showing ${t.count===0?0:t.offset+1}–${t.offset+t.count} of ${t.total}\n    </p>\n    <button\n      type="button"\n      class="button-secondary"\n      disabled=${t.offset+t.count>=t.total}\n      onClick=${()=>t.onChange(t.offset+Q)}\n    >\n      Next\n    </button>\n  </div>`}function vt(t){let n=(t.buckets[t.buckets.length-1]?.capturedCumulative??0)+t.unknownCaptureDates;if(t.buckets.length===0&&n===0&&t.currentOpen===0)return{kind:"empty"};return{kind:"data"}}function an(t){return t==="register-history"?"Register history":"Store"}function ln(t){let e=[],n=t.buckets[t.buckets.length-1],o=n===void 0?null:n.openDifference;if(o!==null&&o!==t.currentOpen)e.push(`The dated history closes at ${o} open issue${o===1?"":"s"}; the store currently records ${t.currentOpen} open. The difference is issues with no recorded date — they are counted, `+"not placed on the timeline.");if(t.unknownCaptureDates>0||t.unknownClosureDates>0){let r=[];if(t.unknownCaptureDates>0)r.push(`${t.unknownCaptureDates} captured issue${t.unknownCaptureDates===1?" has":"s have"} no recorded date`);if(t.unknownClosureDates>0)r.push(`${t.unknownClosureDates} retired issue${t.unknownClosureDates===1?" has":"s have"} no recorded closure date`);e.push(`History is incomplete: ${r.join(" and ")}. Unknown dates stay out of the dated lines and are counted here, never imputed.`)}if(t.buckets.some((r)=>r.origin==="register-history"))e.push("Buckets marked “register history” hold only imported records that predate the issue store.");return e}var cn=720,un=300,we=48,Ae=16,Oe=16,dn=44;function L(t){return Math.round(t*100)/100}function pn(t){let n=t/4,o=10**Math.floor(Math.log10(n)),r=Math.max(1,[1,2,5,10].map((i)=>i*o).find((i)=>i>=n)??o*10),s=[];for(let i=0;i<=t;i+=r)s.push(i);if(s[s.length-1]!==t&&t-(s[s.length-1]??0)>r/2)s.push(t);return s}function fn(t,e=cn,n=un){let o=t.buckets,r=e-we-Ae,s=n-Oe-dn,i=o.length===0?0:o[o.length-1].capturedCumulative,d=Math.max(1,i),u=(f)=>o.length===1?we+r/2:we+r*f/(o.length-1),p=(f)=>Oe+(d-f)/d*s,h=(f)=>{if(o.length===0)return"";if(o.length===1){let S=L(p(f(o[0]))),I=L(u(0));return`M ${L(I-30)} ${S} H ${L(I+30)}`}let y=`M ${L(u(0))} ${L(p(f(o[0])))}`;for(let S=1;S<o.length;S+=1)y+=` H ${L(u(S))} V ${L(p(f(o[S])))}`;return y},g=o.length===0?0:o[o.length-1].retiredCumulative,c=o.length<=3?o.map((f,y)=>y):[0,Math.floor((o.length-1)/2),o.length-1];return{capturedPath:h((f)=>f.capturedCumulative),retiredPath:g===0&&o.every((f)=>f.retiredCumulative===0)?null:h((f)=>f.retiredCumulative),yMax:d,yTicks:pn(d),xLabels:c.map((f)=>({date:o[f].date,x:u(f)})),width:e,height:n,plotTop:Oe,plotHeight:s,plotLeft:we}}function $n(t){let e=t.buckets[t.buckets.length-1];if(e===void 0)return t.currentOpen===0?"No issues have been recorded, so there is no captured-versus-retired history to chart.":`No dated history exists, but the store currently records ${t.currentOpen} open issue${t.currentOpen===1?"":"s"}.`;return`Cumulative captured issues reach ${e.capturedCumulative} by ${e.date}; retired issues (any terminal disposition) reach ${e.retiredCumulative}. The store currently records ${t.currentOpen} open issue${t.currentOpen===1?"":"s"}.`}function hn(t){let e=t.flow,n=fn(e),o=n.plotTop+n.plotHeight;return a`<svg\n    class="flow-chart"\n    viewBox=${`0 0 ${n.width} ${n.height}`}\n    width=${n.width}\n    height=${n.height}\n    role="img"\n    aria-labelledby="flow-chart-title flow-chart-desc"\n  >\n    <title id="flow-chart-title">Cumulative captured vs retired issues over dated history</title>\n    <desc id="flow-chart-desc">${$n(e)}</desc>\n    ${n.yTicks.map((r)=>a`<g key=${r}>\n        <line\n          class="flow-grid"\n          x1=${n.plotLeft}\n          x2=${n.width-Ae}\n          y1=${L(n.plotTop+(n.yMax-r)/n.yMax*n.plotHeight)}\n          y2=${L(n.plotTop+(n.yMax-r)/n.yMax*n.plotHeight)}\n        />\n        <text class="flow-axis-label" x=${n.plotLeft-8} y=${L(n.plotTop+(n.yMax-r)/n.yMax*n.plotHeight)+4} text-anchor="end">${r}</text>\n      </g>`)}\n    <line class="flow-axis" x1=${n.plotLeft} x2=${n.plotLeft} y1=${n.plotTop} y2=${o} />\n    <line class="flow-axis" x1=${n.plotLeft} x2=${n.width-Ae} y1=${o} y2=${o} />\n    ${n.retiredPath===null?null:a`<path class="flow-line flow-line-retired" d=${n.retiredPath} fill="none" stroke-dasharray="6 4" />`}\n    <path class="flow-line flow-line-captured" d=${n.capturedPath} fill="none" />\n    ${n.xLabels.map((r)=>a`<text class="flow-axis-label" key=${r.date} x=${L(r.x)} y=${o+20} text-anchor="middle">${r.date}</text>`)}\n  </svg>`}function kt(t){let e=t.flow;return a`<${m} title="Issue flow">\n    <p class="hint">\n      Cumulative captured vs retired issues by recorded day. Every terminal disposition counts as retired.\n    </p>\n    ${e.status==="loading"?a`<p class="hint">Loading issue flow…</p>`:null}\n    ${e.status==="error"?a`<${w} tone="error">${e.message}</${w}>`:null}\n    ${e.status==="ready"&&vt(e.envelope.data).kind==="empty"?a`<${k}>\n          <p class="prose">\n            No issues have been recorded yet, so there is no captured-versus-retired history to chart. Use the CLI to\n            record a confirmed finding.\n          </p>\n        <//${k}>`:null}\n    ${e.status==="ready"&&vt(e.envelope.data).kind==="data"?(()=>{let n=e.envelope.data,o=ln(n),r=n.buckets[n.buckets.length-1];return a`<p class="flow-open">\n              Currently open (all recorded issues):\n              <strong>${n.currentOpen}</strong>\n              ${r===void 0||r.openDifference===n.currentOpen?null:a`<span class="hint"> · dated history closes at ${r.openDifference} open</span>`}\n            </p>\n            <div class="table-scroll flow-scroll" role="region" aria-label="Issue flow chart" tabindex="0">\n              <figure class="flow-figure">\n                <${hn} flow=${n} />\n                <figcaption class="flow-legend">\n                  <span class="flow-legend-item">\n                    <svg width="28" height="6" aria-hidden="true"><line x1="0" y1="3" x2="28" y2="3" class="flow-line flow-line-captured" /></svg>\n                    Captured (cumulative)\n                  </span>\n                  <span class="flow-legend-item">\n                    <svg width="28" height="6" aria-hidden="true">\n                      <line x1="0" y1="3" x2="28" y2="3" class="flow-line flow-line-retired" stroke-dasharray="6 4" />\n                    </svg>\n                    Retired (cumulative, any terminal disposition)\n                  </span>\n                </figcaption>\n              </figure>\n            </div>\n            ${o.map((s,i)=>a`<p class="hint flow-note" key=${i}>${s}</p>`)}\n            <div class="table-scroll" role="region" aria-label="Issue flow data" tabindex="0">\n              <table class="data-table">\n                <caption>\n                  Issue flow by recorded day — the chart\'s data\n                </caption>\n                <thead>\n                  <tr>\n                    <th scope="col">Day</th>\n                    <th scope="col">Captured (cumulative)</th>\n                    <th scope="col">Retired (cumulative)</th>\n                    <th scope="col">Open (dated)</th>\n                    <th scope="col">Origin</th>\n                  </tr>\n                </thead>\n                <tbody>\n                  ${n.buckets.map((s)=>a`<tr key=${s.date}>\n                      <td class="mono">${s.date}</td>\n                      <td class="col-secondary">${s.capturedCumulative}</td>\n                      <td class="col-secondary">${s.retiredCumulative}</td>\n                      <td class="col-secondary">${s.openDifference}</td>\n                      <td>${an(s.origin)}</td>\n                    </tr>`)}\n                </tbody>\n              </table>\n            </div>`})():null}\n  <//${m}>`}var Dt={open:!0,resolved:!0,waived:!0,duplicate:!0,superseded:!0},St={bug:!0,risk:!0,improvement:!0,request:!0,decision:!0,"review-obligation":!0},Pt={critical:!0,high:!0,medium:!0,low:!0,info:!0},mn=Object.keys(Dt),_n=Object.keys(St),gn=Object.keys(Pt),Fe=50,xt="/api/issue-flow";function yn(t){return t===""?xt:`${xt}?project=${encodeURIComponent(t)}`}var Tt=["project","disposition","kind","severity","q"],Ue=Object.freeze({project:"",disposition:"open",kind:"",severity:"",q:""}),It={filters:Ue,offset:0},wn={disposition:Dt,kind:St,severity:Pt};function bn(t){let e=new URLSearchParams(t),n={...Ue},o=e.get("project");if(o!==null)n.project=o;for(let d of["disposition","kind","severity"]){let u=e.get(d);if(u!==null&&wn[d][u]===!0)n[d]=u}let r=e.get("q");if(r!==null)n.q=r;let s=e.get("offset"),i=s!==null&&/^[0-9]+$/.test(s)?Number(s):0;return{filters:n,offset:i}}function Ct(t){let e=new URLSearchParams;if(e.set("disposition",t.filters.disposition),t.filters.project!=="")e.set("project",t.filters.project);if(t.filters.kind!=="")e.set("kind",t.filters.kind);if(t.filters.severity!=="")e.set("severity",t.filters.severity);if(t.filters.q!=="")e.set("q",t.filters.q);if(e.set("limit",String(Fe)),t.offset>0)e.set("offset",String(t.offset));return e.toString()}function vn(t){return Tt.every((e)=>t[e]===Ue[e])}function kn(t){return(t.buckets[t.buckets.length-1]?.capturedCumulative??0)+t.unknownCaptureDates}function xn(t,e){if(!t)return{kind:"filtered"};if(e.status==="ready")return kn(e.envelope.data)===0?{kind:"store"}:{kind:"filtered"};return e.status==="error"?{kind:"unknown",message:e.message}:{kind:"probing"}}function B(t){if(t===null||t==="")return null;let e=Date.parse(t);return Number.isNaN(e)?null:e}function be(t,e,n){if(t===null&&e===null)return 0;if(t===null)return 1;if(e===null)return-1;return(t-e)*n}function jt(t){let e=null;for(let n of t.occurrences)if(e===null||n.id<e.id)e=n;return e}function In(t){let e=jt(t),n=me(t.provenance);return[...t.occurrences].sort((o,r)=>{let s=be(B(o.discoveredAt),B(r.discoveredAt),-1);if(s!==0)return s;let i=be(B(o.recordedAt),B(r.recordedAt),-1);if(i!==0)return i;return r.id-o.id}).map((o)=>({kind:o.id===e?.id?"Capture":"Recurrence",occurrence:o,at:o.discoveredAt,migration:o.imported?n:null}))}function Cn(t){let e=me(t.provenance);return[...t.transitions].sort((n,o)=>{let r=be(B(n.occurredAt),B(o.occurredAt),1);if(r!==0)return r;let s=be(B(n.recordedAt),B(o.recordedAt),1);if(s!==0)return s;return n.id-o.id}).map((n)=>({summary:`${n.fromDisposition} → ${n.toDisposition}`,transition:n,at:n.occurredAt,migration:n.imported?e:null}))}function He(t){return`#issue/${encodeURIComponent(t)}`}function Dn(t){let e=t.issue;return a`<tr>\n    <td class="col-id mono">${e.id}</td>\n    <td class="col-title">\n      <a\n        id=${`issue-link-${e.id}`}\n        href=${He(e.id)}\n        onClick=${()=>t.onOpenIssue(e.id)}\n        >${e.title}</a\n      >\n      <span class="row-meta">\n        <span class="mono">${e.projectId}</span> · ${e.kind} · Last activity\n        ${D(e.lastActivity)}\n      </span>\n    </td>\n    <td><${_} tone=${Re(e.severity)}>${e.severity}</${_}></td>\n    <td><${_} tone=${Ne(e.disposition)}>${e.disposition}</${_}></td>\n    <td class="col-secondary">${e.kind}</td>\n    <td class="col-secondary mono">${e.projectId}</td>\n    <td class="col-secondary mono">${D(e.lastActivity)}</td>\n  </tr>`}function Sn(t){let e=t.filters;return a`<form class="filters" onChange=${t.onChange} onSubmit=${(n)=>n.preventDefault()}>\n    <div class="filter-field">\n      <label for="filter-project">Project</label>\n      <input id="filter-project" name="project" type="text" value=${e.project} placeholder="All projects" />\n    </div>\n    <div class="filter-field">\n      <label for="filter-disposition">Disposition</label>\n      <select id="filter-disposition" name="disposition">\n        ${mn.map((n)=>a`<option key=${n} value=${n} selected=${n===e.disposition}>${n}</option>`)}\n      </select>\n    </div>\n    <div class="filter-field">\n      <label for="filter-kind">Kind</label>\n      <select id="filter-kind" name="kind">\n        <option value="" selected=${e.kind===""}>Any kind</option>\n        ${_n.map((n)=>a`<option key=${n} value=${n} selected=${n===e.kind}>${n}</option>`)}\n      </select>\n    </div>\n    <div class="filter-field">\n      <label for="filter-severity">Severity</label>\n      <select id="filter-severity" name="severity">\n        <option value="" selected=${e.severity===""}>Any severity</option>\n        ${gn.map((n)=>a`<option key=${n} value=${n} selected=${n===e.severity}>${n}</option>`)}\n      </select>\n    </div>\n    <div class="filter-field filter-field-wide">\n      <label for="filter-q">Title or evidence</label>\n      <input\n        id="filter-q"\n        name="q"\n        type="text"\n        value=${e.q}\n        maxLength=${200}\n        aria-describedby="filter-q-hint"\n      />\n      <span class="hint" id="filter-q-hint">Literal text, up to 200 characters. No patterns.</span>\n    </div>\n    <button type="button" class="button-secondary" onClick=${t.onClear}>Clear Filters</button>\n  </form>`}function Pn(t){switch(t.state.kind){case"store":return a`<${k}><p class="prose">No issues captured. Use the CLI to record a confirmed finding.</p></${k}>`;case"probing":return a`<${k}><p class="prose">Checking the issue store…</p></${k}>`;case"unknown":return a`<${w} tone="warning"\n        >${`Could not read the issue store, so this empty list cannot be told apart from an empty filter result. ${t.state.message}`}</${w}>`;case"filtered":return a`<${k}>\n        <p class="prose">No issues match these filters.</p>\n        <button type="button" class="button-secondary" onClick=${t.onClear}>Clear Filters</button>\n      </${k}>`}}function Et(t){let[e,n]=A(()=>bn(window.location.search)),o=E(`/api/issues?${Ct(e)}`),r=o.status==="ready"&&o.envelope.data.total===0&&vn(e.filters),s=E(yn(e.filters.project)),i=xn(r,s),d=(c)=>{n(c),window.history.replaceState(null,"",`?${Ct(c)}${window.location.hash}`)},u=(c)=>{let f=c.target,y=f.name;if(!Tt.includes(y))return;d({filters:{...e.filters,[y]:f.value},offset:0})};R(()=>{if(t.focusIssueId===null||o.status!=="ready")return;(document.getElementById(`issue-link-${t.focusIssueId}`)??document.getElementById("issues-heading"))?.focus(),t.onFocusRestored()},[t.focusIssueId,o.status]);let p=o.status==="ready"?o.envelope.data.items:[],h=o.status==="ready"?o.envelope.data.total:0,g=o.status==="error"?o.message:s.status==="error"?s.message:o.status==="loading"?"Loading issues.":h===0?"No issues listed.":`${h} issue${h===1?"":"s"} listed.`;return a`<h1 class="heading-28" id="issues-heading" tabindex="-1">Issues</h1>\n    <${Sn} filters=${e.filters} onChange=${u} onClear=${()=>d(It)} />\n    <p class="hint">Listed by severity, then latest real activity, then ID.</p>\n    <${j} message=${g} />\n    ${o.status==="loading"?a`<p class="hint">Loading issues…</p>`:null}\n    ${o.status==="error"?a`<${w} tone="error">${o.message}</${w}>`:null}\n    ${o.status==="ready"&&p.length===0?a`<${Pn} state=${i} onClear=${()=>d(It)} />`:null}\n    ${p.length===0?null:a`<div class="table-scroll" role="region" aria-label="Issue list" tabindex="0">\n            <table class="issue-table">\n              <caption>\n                Issues matching the current filters (${h})\n              </caption>\n              <thead>\n                <tr>\n                  <th scope="col">ID</th>\n                  <th scope="col">Title</th>\n                  <th scope="col">Severity</th>\n                  <th scope="col">Disposition</th>\n                  <th scope="col" class="col-secondary">Kind</th>\n                  <th scope="col" class="col-secondary">Project</th>\n                  <th scope="col" class="col-secondary">Last activity</th>\n                </tr>\n              </thead>\n              <tbody>\n                ${p.map((c)=>a`<${Dn} key=${c.id} issue=${c} onOpenIssue=${t.onOpenIssue} />`)}\n              </tbody>\n            </table>\n          </div>\n          <div class="pager">\n            <button\n              type="button"\n              class="button-secondary"\n              disabled=${e.offset===0}\n              onClick=${()=>d({...e,offset:Math.max(0,e.offset-Fe)})}\n            >\n              Previous\n            </button>\n            <p class="pager-summary">\n              Showing ${e.offset+1}–${e.offset+p.length} of ${h}\n            </p>\n            <button\n              type="button"\n              class="button-secondary"\n              disabled=${e.offset+p.length>=h}\n              onClick=${()=>d({...e,offset:e.offset+Fe})}\n            >\n              Next\n            </button>\n          </div>`}\n    <${kt} flow=${s} />`}function Tn(t){let e=t.row,n=e.occurrence;return a`<li class="history-item">\n    <p class="history-head">\n      <span class="history-kind">${e.kind}</span>\n      <span class="mono">${D(e.at)}</span>\n      ${e.occurrence.imported?a`<${_} tone="terminal">Imported</${_}>`:null}\n    </p>\n    ${e.migration===null?null:a`<p class="history-migration">${e.migration}</p>`}\n    <dl class="facts">\n      <${l} label="Source"><span class="mono">${n.sourceKind} · ${n.sourceIdentity}</span></${l}>\n      <${l} label="Location"><span class="mono">${n.location}</span></${l}>\n      <${l} label="Observed"><span class="prose">${n.observedBehavior}</span></${l}>\n      <${l} label="Recorded"><span class="mono">${D(n.recordedAt)}</span></${l}>\n    </dl>\n    ${n.evidence.length===0?null:a`<ul class="evidence">\n          ${n.evidence.map((o,r)=>a`<li key=${r} class="prose">${o}</li>`)}\n        </ul>`}\n  </li>`}function jn(t){let e=t.row,n=e.transition,o=gt(n.evidence);return a`<li class="history-item">\n    <p class="history-head">\n      <span class="history-kind">${e.summary}</span>\n      <span class="mono">${D(e.at)}</span>\n      ${n.imported?a`<${_} tone="terminal">Imported</${_}>`:null}\n    </p>\n    ${e.migration===null?null:a`<p class="history-migration">${e.migration}</p>`}\n    <dl class="facts">\n      <${l} label="Reason"><span class="prose">${n.reason}</span></${l}>\n      ${n.actor===null?null:a`<${l} label="Actor">${n.actor}</${l}>`}\n      <${l} label="Recorded"><span class="mono">${D(n.recordedAt)}</span></${l}>\n      <${l} label="Revision"><span class="mono">${String(n.issueRevision)}</span></${l}>\n    </dl>\n    ${o===null?null:a`<pre class="legacy-json mono">${o}</pre>`}\n  </li>`}function Lt(t){let e=E(`/api/issues/${encodeURIComponent(t.id)}`);if(R(()=>{let u=(p)=>{if(p.key!=="Escape")return;p.preventDefault(),window.location.hash="#issues"};return window.addEventListener("keydown",u),()=>window.removeEventListener("keydown",u)},[t.id]),e.status==="error")return a`<p class="back-link"><a href="#issues">Back to Issues</a></p>\n      <h1 class="heading-28">Issue ${t.id}</h1>\n      <${j} message=${e.message} />\n      <${w} tone="error">${e.message}</${w}>`;if(e.status==="loading")return a`<p class="back-link"><a href="#issues">Back to Issues</a></p>\n      <h1 class="heading-28">Issue ${t.id}</h1>\n      <p class="hint">Loading issue…</p>`;let n=e.envelope.data,o=jt(n),r=me(n.provenance),s=In(n),i=Cn(n),d=_t(n.url);return a`<p class="back-link"><a href="#issues">Back to Issues</a></p>\n    <${j} message=${`Issue ${n.id} loaded.`} />\n    <h1 class="heading-28">${n.title}</h1>\n    <p class="detail-id mono">${n.id}</p>\n    ${r===null?null:a`<p class="hint">Migrated record — ${r}</p>`}\n    <${m} title="Identity">\n      <dl class="facts">\n        <${l} label="Project"><span class="mono">${n.projectId}</span></${l}>\n        <${l} label="Severity"><${_} tone=${Re(n.severity)}>${n.severity}</${_}></${l}>\n        <${l} label="Disposition"\n          ><${_} tone=${Ne(n.disposition)}>${n.disposition}</${_}></${l}\n        >\n        <${l} label="Kind">${n.kind}</${l}>\n        ${n.owner===null?null:a`<${l} label="Owner">${n.owner}</${l}>`}\n        <${l} label="Registered"><span class="mono">${D(n.registeredAt)}</span></${l}>\n        ${n.disposition==="open"?null:a`<${l} label="Closed"><span class="mono">${D(n.closedAt)}</span></${l}>`}\n        ${n.closureNote===null?null:a`<${l} label="Closure note"><span class="prose">${n.closureNote}</span></${l}>`}\n        ${n.externalId===null?null:a`<${l} label="External ID"><span class="mono">${n.externalId}</span></${l}>`}\n        <${l} label="Revision"><span class="mono">${String(n.revision)}</span></${l}>\n      </dl>\n      ${d===null?null:a`<p class="external"><a href=${d} rel="noreferrer noopener">${n.url}</a></p>`}\n    </${m}>\n    ${o===null?null:a`<${m} title="Source">\n          <dl class="facts">\n            <${l} label="Source kind">${o.sourceKind}</${l}>\n            <${l} label="Source identity"><span class="mono">${o.sourceIdentity}</span></${l}>\n            <${l} label="Location"><span class="mono">${o.location}</span></${l}>\n            <${l} label="Root cause key"><span class="mono">${o.rootCauseKey}</span></${l}>\n            <${l} label="Acceptance key"><span class="mono">${o.acceptanceKey}</span></${l}>\n          </dl>\n        </${m}>`}\n    <${m} title="Impact"><p class="prose">${n.impact}</p></${m}>\n    <${m} title="Acceptance"><p class="prose">${n.acceptance}</p></${m}>\n    <${m} title="Occurrences">\n      ${s.length===0?a`<p class="prose">No occurrences recorded for this issue.</p>`:a`<ul class="history">\n            ${s.map((u)=>a`<${Tn} key=${u.occurrence.id} row=${u} />`)}\n          </ul>`}\n    </${m}>\n    <${m} title="Disposition history">\n      ${i.length===0?a`<p class="prose">No disposition transitions recorded for this issue.</p>`:a`<ul class="history">\n            ${i.map((u)=>a`<${jn} key=${u.transition.id} row=${u} />`)}\n          </ul>`}\n    </${m}>\n    <${m} title="Relations">\n      ${n.relations.length===0?a`<p class="prose">No relations recorded for this issue.</p>`:a`<ul class="relations">\n            ${n.relations.map((u)=>a`<li key=${`${u.fromIssue}\\x00${u.relation}\\x00${u.toIssue}`}>\n                <a class="mono" href=${He(u.fromIssue)}>${u.fromIssue}</a>\n                ${u.relation}\n                <a class="mono" href=${He(u.toIssue)}>${u.toIssue}</a>\n              </li>`)}\n          </ul>`}\n    </${m}>\n    ${n.provenance.length===0?null:a`<${m} title="Provenance">\n          <ul class="relations">\n            ${n.provenance.map((u)=>a`<li key=${u.id}>\n                <dl class="facts">\n                  <${l} label="Kind">${u.kind}</${l}>\n                  <${l} label="Target"><span class="mono">${u.target}</span></${l}>\n                  <${l} label="Source hash"><span class="mono">${u.sourceHash}</span></${l}>\n                  ${u.legacyProject===null?null:a`<${l} label="Legacy project">${u.legacyProject}</${l}>`}\n                  ${u.legacyBucket===null?null:a`<${l} label="Legacy bucket">${u.legacyBucket}</${l}>`}\n                  ${u.legacyEntryId===null?null:a`<${l} label="Legacy entry">${u.legacyEntryId}</${l}>`}\n                  ${u.importedAt===null?null:a`<${l} label="Imported"><span class="mono">${D(u.importedAt)}</span></${l}>`}\n                </dl>\n                ${u.legacyJson===null?null:a`<pre class="legacy-json mono">${u.legacyJson}</pre>`}\n              </li>`)}\n          </ul>\n        </${m}>`}`}function En(t){return{disclosure:J(t.projection),content:t.data.total===0?{kind:"empty"}:{kind:"listed",total:t.data.total}}}function Rt(t,e){if(z(e))return{kind:"unavailable"};return t.workflow===null?{kind:"not-started"}:{kind:"row",workflow:t.workflow}}function Ln(t,e){let n=t.execution===null?{kind:e?"not-started":"unknown"}:{kind:"row",row:t.execution,pin:_e(t.catalogPinRevision,t.catalog?.revision??null)};return{planId:t.planId,catalog:t.catalog,badges:t.badges,execution:n}}function Rn(t){let e=t.row,n=e.catalog;return a`<li class="history-item">\n    <p class="history-head">\n      <span class="history-kind mono">${e.planId}</span>\n      <span class="mono">${n===null?"No catalog row":n.title}</span>\n    </p>\n    <${U} badges=${e.badges} />\n    <dl class="facts">\n      ${n===null?null:a`<${l} label="Catalog location"\n              ><span class="mono">${`${n.rootKind}:${n.relativePath}`}</span></${l}\n            >\n            <${l} label="Catalog lifecycle"\n              ><${_} tone=${W(n.lifecycle)}>${n.lifecycle}</${_}></${l}\n            >`}\n      ${e.execution.kind==="row"?a`<${l} label="Projected status">${T(e.execution.row.status)}</${l}>\n            <${l} label="Projected phase">${T(e.execution.row.phase)}</${l}>\n            <${l} label="Projected progress">${T(e.execution.row.progress)}</${l}>\n            <${l} label="Projected workflow"><span class="mono">${e.execution.row.workflowId}</span></${l}>\n            ${e.execution.row.doneAt===null?null:a`<${l} label="Projected done at"\n                  ><span class="mono">${D(e.execution.row.doneAt)}</span></${l}>`}`:null}\n    </dl>\n    ${e.execution.kind==="row"?a`<p class="hint">${ge(e.execution.pin)}</p>`:a`<p class="hint">\n          ${e.execution.kind==="unknown"?"Execution unknown: no valid projection generation is published, so no execution row is claimed for this plan.":"No execution row: this plan has no row in the projection, so it carries no phase, progress or prepared pin."}\n        </p>`}\n  </li>`}function Nn(t){let e=t.iteration,n=e.catalog,o=Rt(e,t.projection),r=o.kind==="unavailable"?"Execution data unavailable":o.kind==="not-started"?"No execution row":`${o.workflow.status}${o.workflow.phase===null?"":` · ${o.workflow.phase}`}`;return a`<tr>\n    <td class="col-id mono">\n      <a href=${`#iteration/${encodeURIComponent(e.iterationId)}`}>${e.iterationId}</a>\n    </td>\n    <td class="col-title">\n      ${n===null?a`<span class="mono">${e.iterationId}</span>`:n.title}\n      <span class="row-meta">\n        Projected execution ${r} · Catalog plans ${e.plans.length} · Catalog documents\n        ${e.documents.length}\n      </span>\n      <${U} badges=${e.badges} />\n    </td>\n    <td class="col-secondary">\n      ${n===null?a`<${_} tone="warning">No catalog row</${_}>`:a`<${_} tone=${W(n.lifecycle)}>${n.lifecycle}</${_}>`}\n    </td>\n    <td>${r}</td>\n    <td class="col-secondary">${String(e.plans.length)}</td>\n    <td class="col-secondary">${String(e.documents.length)}</td>\n  </tr>`}function Nt(){let[t,e]=A(0),n=new URLSearchParams({limit:String(Q)});if(t>0)n.set("offset",String(t));let o=E(`/api/iterations?${n.toString()}`),r=o.status==="ready"?En(o.envelope):null,s=o.status==="ready"?o.envelope.projection:null,i=o.status==="ready"?o.envelope.data.items:[],d=o.status==="ready"?o.envelope.data.total:0,u=o.status==="error"?o.message:o.status==="loading"?"Loading iterations.":r?.content.kind==="empty"?"No iterations listed.":`${d} iteration${d===1?"":"s"} listed.`;return a`<h1 class="heading-28" id="iterations-heading" tabindex="-1">Iterations</h1>\n    <p class="hint">\n      Iteration, plan and document membership comes from the catalog and is shown whether or not execution has started.\n      Execution status, phase and progress are the projection.\n    </p>\n    <${j} message=${u} />\n    ${o.status==="loading"?a`<p class="hint">Loading iterations…</p>`:null}\n    ${o.status==="error"?a`<${w} tone="error">${o.message}</${w}>`:null}\n    ${r===null||r.disclosure===null?null:a`<${K} disclosure=${r.disclosure} />`}\n    ${r?.content.kind==="empty"?a`<${k}><p class="prose">No iterations are registered in the catalog.</p></${k}>`:null}\n    ${s===null||i.length===0?null:a`<div class="table-scroll" role="region" aria-label="Iteration list" tabindex="0">\n            <table class="data-table">\n              <caption>\n                Catalog iterations (${d})\n              </caption>\n              <thead>\n                <tr>\n                  <th scope="col">ID</th>\n                  <th scope="col">Catalog title</th>\n                  <th scope="col" class="col-secondary">Catalog lifecycle</th>\n                  <th scope="col">Projected execution</th>\n                  <th scope="col" class="col-secondary">Catalog plans</th>\n                  <th scope="col" class="col-secondary">Catalog documents</th>\n                </tr>\n              </thead>\n              <tbody>\n                ${i.map((p)=>a`<${Nn} key=${p.iterationId} iteration=${p} projection=${s} />`)}\n              </tbody>\n            </table>\n          </div>\n          <${ye} offset=${t} count=${i.length} total=${d} onChange=${e} />`}`}function On(t,e){if(!e)return{kind:"unknown"};return t===null?{kind:"absent"}:{kind:"document",compass:t}}function An(t){let e=On(t.compass,t.projectionAvailable);if(e.kind==="unknown")return a`<${m} title="Compass (projected)">\n      <p class="prose">\n        Not available: no valid projection generation is published, so nothing is claimed about this iteration\'s\n        compass.\n      </p>\n    </${m}>`;if(e.kind==="absent")return a`<${m} title="Compass (projected)">\n      <p class="prose">No compass document is projected for this iteration.</p>\n    </${m}>`;let n=e.compass;return a`<${m} title="Compass (projected)">\n    <dl class="facts">\n      ${n.summary===null?null:a`<${l} label="Projected summary"><span class="prose">${n.summary}</span></${l}>`}\n      <${l} label="Projected compass status">${T(n.status)}</${l}>\n      ${n.startedAt===null?null:a`<${l} label="Projected started"><span class="mono">${D(n.startedAt)}</span></${l}>`}\n      ${n.endedAt===null?null:a`<${l} label="Projected ended"><span class="mono">${D(n.endedAt)}</span></${l}>`}\n    </dl>\n    ${n.milestones.length===0?a`<p class="hint">No milestones are recorded in the compass document.</p>`:a`<ul class="relations">\n          ${n.milestones.map((o)=>a`<li key=${o.milestone} class="mono">\n              ${o.milestone} · target ${T(o.target)} · status\n              ${T(o.status)}\n            </li>`)}\n        </ul>`}\n  </${m}>`}function Ot(t){let e=E(`/api/iterations/${encodeURIComponent(t.id)}`);if(R(()=>{let u=(p)=>{if(p.key!=="Escape")return;p.preventDefault(),window.location.hash="#iterations"};return window.addEventListener("keydown",u),()=>window.removeEventListener("keydown",u)},[t.id]),e.status==="error")return a`<p class="back-link"><a href="#iterations">Back to Iterations</a></p>\n      <h1 class="heading-28">Iteration ${t.id}</h1>\n      <${j} message=${e.message} />\n      <${w} tone="error">${e.message}</${w}>`;if(e.status==="loading")return a`<p class="back-link"><a href="#iterations">Back to Iterations</a></p>\n      <h1 class="heading-28">Iteration ${t.id}</h1>\n      <p class="hint">Loading iteration…</p>`;let n=e.envelope.data,o=e.envelope.projection,r=J(o),s=!z(o),i=Rt(n,o),d=n.catalog;return a`<p class="back-link"><a href="#iterations">Back to Iterations</a></p>\n    <${j} message=${`Iteration ${n.iterationId} loaded.`} />\n    <h1 class="heading-28">${d===null?n.iterationId:d.title}</h1>\n    <p class="detail-id mono">${n.iterationId}</p>\n    ${r===null?null:a`<${K} disclosure=${r} />`}\n    <${U} badges=${n.badges} />\n    <${m} title="Catalog">\n      ${d===null?a`<${w} tone="warning"\n            >No catalog row exists for ${n.iterationId}: its title, description, location and lifecycle are not\n            available. Plan and document membership below comes from catalog links, not from the execution\n            projection.</${w}>`:a`<${Z} catalog=${d} />`}\n    </${m}>\n    <${m} title="Execution (projected)">\n      ${i.kind==="unavailable"?a`<p class="prose">\n            Execution unknown: no valid projection generation is published, so nothing is claimed about this\n            iteration\'s execution row. Its catalog membership below is unaffected.\n          </p>`:i.kind==="not-started"?a`<p class="prose">\n              No execution row: this iteration has not started execution in the projection. Its catalog membership\n              below is unaffected.\n            </p>`:a`<dl class="facts">\n              <${l} label="Projected workflow"><span class="mono">${i.workflow.id}</span></${l}>\n              <${l} label="Projected status"\n                ><${_} tone="neutral">${i.workflow.status}</${_}></${l}\n              >\n              <${l} label="Projected phase">${T(i.workflow.phase)}</${l}>\n              <${l} label="Root register"\n                >${i.workflow.activeRegistration?"Listed as an active workflow":"Not listed as active"}</${l}\n              >\n            </dl>`}\n    </${m}>\n    <${An} compass=${n.compass} projectionAvailable=${s} />\n    <${m} title="Plans">\n      <p class="hint">Catalog membership, with the projection\'s execution overlay when one exists.</p>\n      ${n.plans.length===0?a`<p class="prose">No plans are linked to this iteration in the catalog.</p>`:a`<ul class="history">\n            ${n.plans.map((u)=>a`<${Rn} key=${u.planId} row=${Ln(u,s)} />`)}\n          </ul>`}\n    </${m}>\n    <${m} title="Documents">\n      <p class="hint">Catalog membership: the document bodies stay files and are never read here.</p>\n      ${n.documents.length===0?a`<p class="prose">No documents are linked to this iteration in the catalog.</p>`:a`<ul class="history">\n            ${n.documents.map((u)=>a`<li key=${u.id} class="history-item">\n                <p class="history-head">\n                  <span class="history-kind">${u.title}</span>\n                  <${_} tone=${W(u.lifecycle)}>${u.lifecycle}</${_}>\n                  ${u.documentKind===null?null:a`<${_} tone="neutral">${u.documentKind}</${_}>`}\n                </p>\n                <dl class="facts">\n                  <${l} label="Catalog location"\n                    ><span class="mono">${`${u.rootKind}:${u.relativePath}`}</span></${l}\n                  >\n                  <${l} label="Catalog revision"><span class="mono">${String(u.revision)}</span></${l}>\n                </dl>\n                ${u.description===null?null:a`<p class="prose">${u.description}</p>`}\n              </li>`)}\n          </ul>`}\n    </${m}>`}function Fn(t){let e=new URLSearchParams(t).get("project");return e===null||e.trim()===""?null:e}function Hn(t){let e=t.data;return{disclosure:null,content:e===null?{kind:"not-found"}:e.authority.state==="absent"?{kind:"absent",roadmap:e}:{kind:"ready",roadmap:e}}}function At(){let t=Fn(window.location.search),e=E(t===null?null:`/api/roadmap?${new URLSearchParams({project:t}).toString()}`),n=e.status==="ready"?Hn(e.envelope):null,o=a`<h1 class="heading-28" id="roadmap-heading" tabindex="-1">Roadmap</h1>`;if(t===null)return a`${o}\n      <p class="hint">The roadmap view reads one project\'s authoritative roadmap document. Direction, goals, milestones and complete source text are shown read-only.</p>\n      <${j} message="No project selected." />\n      <${k}>\n        <p class="prose">\n          No project is selected. Add the project to the dashboard URL — for example\n          <span class="mono">/?project=engine#roadmap</span> — then reload.\n        </p>\n      </${k}>`;let r=n===null||n.content.kind==="not-found"?null:n.content.roadmap,s=e.status==="error"?e.message:e.status==="loading"?"Loading roadmap.":n?.content.kind==="not-found"?`Project ${t} was not found in the catalog.`:n?.content.kind==="absent"?"No roadmap content is stored for this project.":"Roadmap loaded.";return a`${o}\n    <p class="hint">Project ${t} · authoritative stored roadmap content. Read-only: use the roadmap CLI to import or replace it.</p>\n    <${j} message=${s} />\n    ${e.status==="loading"?a`<p class="hint">Loading roadmap…</p>`:null}\n    ${e.status==="error"?a`<${w} tone="error">${e.message}</${w}>`:null}\n    ${n?.content.kind==="not-found"?a`<${k}><p class="prose">Project ${t} was not found in the catalog. Check the project id and try again.</p></${k}>`:null}\n    ${r!==null?a`<${m} title="Catalog"><${Z} catalog=${r.catalog} /></${m}>`:null}\n    ${n?.content.kind==="absent"?a`<${m} title="Roadmap">\n          <p class="prose">No roadmap content is stored for project ${t}. This is distinct from a store read failure.</p>\n        </${m}>`:null}\n    ${n?.content.kind==="ready"&&r?.content!==null?a`<${m} title="Direction">\n            ${r.content.direction===null?a`<p class="prose">No direction text is recorded in the roadmap document.</p>`:a`<p class="prose">${r.content.direction}</p>`}\n          </${m}>\n          <${m} title="Goals">\n            ${r.content.goals.length===0?a`<p class="prose">No goals are recorded in the roadmap document.</p>`:a`<ul class="history">\n                  ${r.content.goals.map((i,d)=>a`<li key=${d} class="history-item">\n                    <p class="history-head"><span class="history-kind">${i.checked?"Done":"Not done"}</span></p>\n                    <p class="prose">${i.title}</p>\n                  </li>`)}\n                </ul>`}\n          </${m}>\n          <${m} title="Milestones">\n            ${r.content.milestones.length===0?a`<p class="prose">No milestones are named in the roadmap document frontmatter.</p>`:a`<ul class="relations">${r.content.milestones.map((i,d)=>a`<li key=${d} class="mono">${i}</li>`)}</ul>`}\n          </${m}>\n          <${m} title="Complete roadmap document"><pre class="prose">${r.content.contentMarkdown}</pre></${m}>`:null}`}function Un(t){let e=J(t.projection);if(z(t.projection))return{disclosure:e,content:{kind:"unavailable"}};return{disclosure:e,content:t.data.total===0?{kind:"empty"}:{kind:"listed",total:t.data.total}}}function Wn(t){let e=J(t.projection);if(t.data===null||z(t.projection))return{kind:"unavailable",disclosure:e};return{kind:"loaded",workflow:t.data,disclosure:e}}function Bn(t){let e=t.plan,n=e.catalog,o=_e(e.catalogPinRevision,n?.revision??null);return a`<li class="history-item">\n    <p class="history-head">\n      <span class="history-kind mono">${e.planId}</span>\n      <span class="mono">${n===null?"No catalog row":n.title}</span>\n    </p>\n    <${U} badges=${e.badges} />\n    <dl class="facts">\n      <${l} label="Projected status">${T(e.status)}</${l}>\n      <${l} label="Projected phase">${T(e.phase)}</${l}>\n      <${l} label="Projected progress">${T(e.progress)}</${l}>\n      ${e.doneAt===null?null:a`<${l} label="Projected done at"><span class="mono">${D(e.doneAt)}</span></${l}>`}\n      ${n===null?null:a`<${l} label="Catalog location"\n              ><span class="mono">${`${n.rootKind}:${n.relativePath}`}</span></${l}\n            >\n            <${l} label="Catalog lifecycle"\n              ><${_} tone=${W(n.lifecycle)}>${n.lifecycle}</${_}></${l}\n            >`}\n    </dl>\n    <p class="hint">${ge(o)}</p>\n    ${e.leases.length===0?a`<p class="hint">No lease row is projected for this plan.</p>`:a`<ul class="relations">\n          ${e.leases.map((r)=>a`<li key=${r.kind} class="mono">\n              ${r.kind} lease · holder ${T(r.holder)} · worktree ${T(r.worktreePath)} ·\n              ${r.expiresAt===null?" no recorded expiry":` expires ${r.expiresAt}`}\n            </li>`)}\n        </ul>`}\n  </li>`}function Mn(t){let e=t.workflow,n=e.catalog;return a`<tr>\n    <td class="col-id mono">\n      <a href=${`#workflow/${encodeURIComponent(e.id)}`}>${e.id}</a>\n    </td>\n    <td class="col-title">\n      ${n===null?a`<span class="mono">${e.id}</span>`:n.title}\n      <span class="row-meta">\n        <span class="mono">${e.type}</span> · Projected status ${e.status} · Projected phase\n        ${T(e.phase)}\n      </span>\n      <${U} badges=${e.badges} />\n    </td>\n    <td><${_} tone="neutral">${e.status}</${_}></td>\n    <td class="col-secondary">${T(e.phase)}</td>\n    <td class="col-secondary">\n      ${n===null?a`<${_} tone="warning">No catalog row</${_}>`:a`<${_} tone=${W(n.lifecycle)}>${n.lifecycle}</${_}>`}\n    </td>\n    <td class="col-secondary">${e.activeRegistration?"Listed as active":"Not listed as active"}</td>\n    <td class="col-secondary mono">${e.updatedAt===null?"Not recorded":D(e.updatedAt)}</td>\n  </tr>`}function Ft(){let[t,e]=A(0),n=new URLSearchParams({limit:String(Q)});if(t>0)n.set("offset",String(t));let o=E(`/api/workflows?${n.toString()}`),r=o.status==="ready"?Un(o.envelope):null,s=o.status==="ready"?o.envelope.data.items:[],i=o.status==="ready"?o.envelope.data.total:0,d=o.status==="error"?o.message:o.status==="loading"?"Loading workflows.":r?.content.kind==="unavailable"?"Execution data is unavailable.":r?.content.kind==="empty"?"No workflows listed.":`${i} workflow${i===1?"":"s"} listed.`;return a`<h1 class="heading-28" id="workflows-heading" tabindex="-1">Workflows</h1>\n    <p class="hint">\n      Projected status, phase, progress, times and leases come from the execution projection, joined to the catalog by\n      id. Titles, locations and lifecycle come from the catalog.\n    </p>\n    <${j} message=${d} />\n    ${o.status==="loading"?a`<p class="hint">Loading workflows…</p>`:null}\n    ${o.status==="error"?a`<${w} tone="error">${o.message}</${w}>`:null}\n    ${r===null||r.disclosure===null?null:a`<${K} disclosure=${r.disclosure} />`}\n    ${r?.content.kind==="empty"?a`<${k}><p class="prose">No workflows are registered in the execution projection.</p></${k}>`:null}\n    ${r?.content.kind==="unavailable"?a`<${k}\n          ><p class="prose">\n            Not available: no valid projection generation is published, so no workflow rows are listed here and\n            nothing is claimed about registered work. That is not an empty workflow registry.\n          </p></${k}\n        >`:null}\n    ${r?.content.kind!=="listed"?null:a`<div class="table-scroll" role="region" aria-label="Workflow list" tabindex="0">\n            <table class="data-table">\n              <caption>\n                Workflows in the current projection (${i})\n              </caption>\n              <thead>\n                <tr>\n                  <th scope="col">ID</th>\n                  <th scope="col">Catalog title</th>\n                  <th scope="col">Projected status</th>\n                  <th scope="col" class="col-secondary">Projected phase</th>\n                  <th scope="col" class="col-secondary">Catalog lifecycle</th>\n                  <th scope="col" class="col-secondary">Root register</th>\n                  <th scope="col" class="col-secondary">Projected updated</th>\n                </tr>\n              </thead>\n              <tbody>\n                ${s.map((u)=>a`<${Mn} key=${u.id} workflow=${u} />`)}\n              </tbody>\n            </table>\n          </div>\n          <${ye} offset=${t} count=${s.length} total=${i} onChange=${e} />`}`}function Ht(t){let e=E(`/api/workflows/${encodeURIComponent(t.id)}`);if(R(()=>{let d=(u)=>{if(u.key!=="Escape")return;u.preventDefault(),window.location.hash="#workflows"};return window.addEventListener("keydown",d),()=>window.removeEventListener("keydown",d)},[t.id]),e.status==="error")return a`<p class="back-link"><a href="#workflows">Back to Workflows</a></p>\n      <h1 class="heading-28">Workflow ${t.id}</h1>\n      <${j} message=${e.message} />\n      <${w} tone="error">${e.message}</${w}>`;if(e.status==="loading")return a`<p class="back-link"><a href="#workflows">Back to Workflows</a></p>\n      <h1 class="heading-28">Workflow ${t.id}</h1>\n      <p class="hint">Loading workflow…</p>`;let n=Wn(e.envelope);if(n.kind==="unavailable")return a`<p class="back-link"><a href="#workflows">Back to Workflows</a></p>\n      <h1 class="heading-28">Workflow ${t.id}</h1>\n      <${j} message="Workflow data is unavailable." />\n      ${n.disclosure===null?null:a`<${K} disclosure=${n.disclosure} />`}\n      <${k}\n        ><p class="prose">\n          Not available: no valid projection generation is published, so this workflow\'s execution row, branch and\n          plan rows cannot be read here and nothing is claimed about them. That is not a claim that no such workflow\n          exists.\n        </p></${k}\n      >`;let{workflow:o,disclosure:r}=n,s=o.catalog,i=[["Projected branch base",o.branch.base],["Projected branch source",o.branch.source],["Projected branch integration",o.branch.integration],["Projected branch target",o.branch.target]];return a`<p class="back-link"><a href="#workflows">Back to Workflows</a></p>\n    <${j} message=${`Workflow ${o.id} loaded.`} />\n    <h1 class="heading-28">${s===null?o.id:s.title}</h1>\n    <p class="detail-id mono">${o.id}</p>\n    ${r===null?null:a`<${K} disclosure=${r} />`}\n    <${U} badges=${o.badges} />\n    <${m} title="Execution (projected)">\n      <p class="hint">\n        Read from the execution projection, which mirrors the JSON execution authority. It is never refreshed from the\n        catalog.\n      </p>\n      <dl class="facts">\n        <${l} label="Projected type">${o.type}</${l}>\n        <${l} label="Projected status"><${_} tone="neutral">${o.status}</${_}></${l}>\n        <${l} label="Projected phase">${T(o.phase)}</${l}>\n        <${l} label="Root register"\n          >${o.activeRegistration?"Listed as an active workflow":"Not listed as active"}</${l}\n        >\n        ${o.startedAt===null?null:a`<${l} label="Projected started"\n              ><span class="mono">${D(o.startedAt)}</span></${l}\n            >`}\n        ${o.endedAt===null?null:a`<${l} label="Projected ended"\n              ><span class="mono">${D(o.endedAt)}</span></${l}\n            >`}\n        ${o.updatedAt===null?null:a`<${l} label="Projected updated"\n              ><span class="mono">${D(o.updatedAt)}</span></${l}\n            >`}\n        ${i.map(([d,u])=>a`<${l} label=${d}>${T(u)}</${l}>`)}\n      </dl>\n    </${m}>\n    <${m} title="Catalog">\n      ${s===null?a`<${w} tone="warning"\n            >No catalog row exists for ${o.id}: its title, description, location and lifecycle are not\n            available. Nothing is inferred from the projected execution row.</${w}>`:a`<${Z} catalog=${s} />`}\n    </${m}>\n    <${m} title="Plans">\n      ${o.plans.length===0?a`<p class="prose">No plan execution rows are projected for this workflow.</p>`:a`<ul class="history">\n            ${o.plans.map((d)=>a`<${Bn} key=${d.planId} plan=${d} />`)}\n          </ul>`}\n    </${m}>`}var Vn=[{id:"issues",label:"Issues"},{id:"workflows",label:"Workflows"},{id:"iterations",label:"Iterations"},{id:"roadmap",label:"Roadmap"}],Kn={issues:"issues",issue:"issues",workflows:"workflows",workflow:"workflows",iterations:"iterations",iteration:"iterations",roadmap:"roadmap"};function Ut(t){let e=t.replace(/^#/,"").split("/"),n=e[0],o=e[1];if(o!==void 0&&o!==""){let r;try{r=decodeURIComponent(o)}catch{return{name:"issues"}}if(n==="issue")return{name:"issue",id:r};if(n==="workflow")return{name:"workflow",id:r};if(n==="iteration")return{name:"iteration",id:r};return{name:"issues"}}if(n==="workflows")return{name:"workflows"};if(n==="iterations")return{name:"iterations"};if(n==="roadmap")return{name:"roadmap"};return{name:"issues"}}function qn(t){let e=t.route;switch(e.name){case"issue":return a`<${Lt} key=${e.id} id=${e.id} />`;case"workflow":return a`<${Ht} key=${e.id} id=${e.id} />`;case"iteration":return a`<${Ot} key=${e.id} id=${e.id} />`;case"workflows":return a`<${Ft} />`;case"iterations":return a`<${Nt} />`;case"roadmap":return a`<${At} />`;case"issues":return a`<${Et}\n        focusIssueId=${t.returnFocusId}\n        onFocusRestored=${t.onFocusRestored}\n        onOpenIssue=${t.onOpenIssue}\n      />`}}function Gn(){let[t,e]=A(()=>Ut(window.location.hash)),n=$t(null);R(()=>{let r=()=>{e(Ut(window.location.hash)),window.scrollTo({top:0})};return window.addEventListener("hashchange",r),()=>window.removeEventListener("hashchange",r)},[]);let o=Kn[t.name];return a`\n    <a class="skip-link" href="#main">Skip to content</a>\n    <header class="app-header">\n      <nav class="app-nav" aria-label="Primary">\n        <span class="app-title">Morning Star</span>\n        ${Vn.map((r)=>a`\n            <a\n              key=${r.id}\n              class="nav-link${r.id===o?" is-active":""}"\n              href=${`#${r.id}`}\n              aria-current=${r.id===o?"page":null}\n            >\n              ${r.label}\n            </a>\n          `)}\n      </nav>\n    </header>\n    <main id="main" class="app-main">\n      <${qn}\n        route=${t}\n        returnFocusId=${n.current}\n        onFocusRestored=${()=>{n.current=null}}\n        onOpenIssue=${(r)=>{n.current=r}}\n      />\n    </main>\n    <footer class="app-footer">Read-only · Make changes with the CLI</footer>\n  `}var Wt=document.getElementById("app");if(Wt)fe(a`<${Gn} />`,Wt);\n';
var dashboardCss = `/*
 * Dashboard styles — token values come verbatim from DESIGN.md frontmatter
 * (CSS custom properties are the implementation mapping; DESIGN.md is the SSOT).
 */

:root {
  /* colors */
  --color-background-100: #ffffff;
  --color-background-200: #f5f7fa;
  --color-background-300: #edf1f6;
  --color-gray-400: #d5dce5;
  --color-gray-600: #8995a6;
  --color-gray-900: #506070;
  --color-gray-1000: #1c2430;
  --color-blue-700: #1756b8;
  --color-blue-800: #12458f;
  --color-blue-100: #eaf1ff;
  --color-red-700: #b42318;
  --color-red-100: #fff0ed;
  --color-amber-700: #a35300;
  --color-amber-100: #fff5e5;
  --color-green-700: #147d48;
  --color-green-100: #eaf8ef;
  --color-purple-700: #7042a0;

  /* spacing (8px rhythm; 8 inside groups, 16 between groups, 32 between sections) */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;

  /* rounded */
  --rounded-sm: 6px;

  /* typography families */
  --font-sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  padding: 0;
}

body {
  background: var(--color-background-200);
  color: var(--color-gray-1000);
  font-family: var(--font-sans);
  font-size: 16px;
  line-height: 1.6;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

#app {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.heading-28 {
  font-size: 28px;
  font-weight: 600;
  line-height: 1.25;
  letter-spacing: -0.02em;
  margin: 0 0 var(--space-4);
}

/* Skip link — visible on focus only */
.skip-link {
  position: absolute;
  left: -9999px;
  top: 0;
  background: var(--color-background-100);
  color: var(--color-blue-700);
  padding: var(--space-2) var(--space-4);
  border-radius: var(--rounded-sm);
  z-index: 10;
}

.skip-link:focus {
  left: var(--space-4);
  top: var(--space-4);
}

/* Header / navigation */
.app-header {
  background: var(--color-background-100);
  border-bottom: 1px solid var(--color-gray-400);
}

.app-nav {
  max-width: 1440px;
  margin: 0 auto;
  padding: var(--space-2) var(--space-8);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.app-title {
  font-weight: 600;
  margin-right: var(--space-4);
}

.nav-link {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding: 0 var(--space-4);
  border-radius: var(--rounded-sm);
  color: var(--color-gray-1000);
  text-decoration: none;
}

.nav-link:hover {
  background: var(--color-background-200);
}

.nav-link.is-active {
  color: var(--color-blue-700);
  background: var(--color-blue-100);
  font-weight: 600;
}

/* Main content */
.app-main {
  flex: 1;
  width: 100%;
  max-width: 1440px;
  margin: 0 auto;
  padding: var(--space-8) var(--space-8);
}

/* Issues: filters */
.filters {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--space-4);
  padding: var(--space-4);
  background: var(--color-background-100);
  border: 1px solid var(--color-gray-400);
  border-radius: var(--rounded-sm);
}

.filter-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 180px;
}

.filter-field-wide {
  flex: 1 1 280px;
}

.filter-field label {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
}

.filter-field input,
.filter-field select {
  height: 44px;
  padding: 0 12px;
  font-family: var(--font-sans);
  font-size: 16px;
  line-height: 1.6;
  color: var(--color-gray-1000);
  background: var(--color-background-100);
  border: 1px solid var(--color-gray-600);
  border-radius: var(--rounded-sm);
}

.button-secondary {
  height: 44px;
  padding: 0 16px;
  font-family: var(--font-sans);
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--color-gray-1000);
  background: var(--color-background-100);
  border: 1px solid var(--color-gray-600);
  border-radius: var(--rounded-sm);
  cursor: pointer;
}

.button-secondary:hover:enabled {
  background: var(--color-background-200);
}

.button-secondary:active:enabled {
  background: var(--color-background-300);
}

.button-secondary:disabled {
  color: var(--color-gray-900);
  background: var(--color-background-300);
  border-color: var(--color-gray-400);
  cursor: default;
}

.hint {
  margin: var(--space-2) 0 0;
  color: var(--color-gray-900);
  font-size: 14px;
  line-height: 1.5;
}

/* Issues: list */
.table-scroll {
  overflow-x: auto;
  background: var(--color-background-100);
  border: 1px solid var(--color-gray-400);
  border-radius: var(--rounded-sm);
}

/* Issue list, workflow list, iteration list: one flat data-table pattern. */
.issue-table,
.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
  line-height: 1.5;
}

.issue-table caption,
.data-table caption {
  padding: var(--space-3) var(--space-4);
  color: var(--color-gray-900);
  text-align: left;
}

.issue-table th,
.issue-table td,
.data-table th,
.data-table td {
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--color-gray-400);
  text-align: left;
  vertical-align: top;
}

.issue-table thead th,
.data-table thead th {
  border-top: none;
  color: var(--color-gray-900);
  font-weight: 600;
}

.issue-table tbody tr:hover,
.data-table tbody tr:hover {
  background: var(--color-background-200);
}

.col-id,
.col-secondary {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.col-title {
  min-width: 240px;
}

.col-title a {
  color: var(--color-blue-700);
}

/* Secondary metadata for narrow screens (shown below the title, never instead of it) */
.row-meta {
  display: none;
}

.mono {
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.6;
}

.badge {
  display: inline-block;
  padding: 2px var(--space-2);
  border: 1px solid var(--color-gray-600);
  border-radius: var(--rounded-sm);
  background: var(--color-background-200);
  font-size: 14px;
  line-height: 1.4;
  color: var(--color-gray-1000);
}

.badge[data-tone="danger"] {
  color: var(--color-red-700);
  background: var(--color-red-100);
  border-color: var(--color-red-700);
}

.badge[data-tone="success"] {
  color: var(--color-green-700);
  background: var(--color-green-100);
  border-color: var(--color-green-700);
}

.badge[data-tone="terminal"] {
  color: var(--color-purple-700);
  background: var(--color-background-100);
  border-color: var(--color-purple-700);
}

/* Amber for a disclosed data gap: a missing catalog join, pin or execution row. */
.badge[data-tone="warning"] {
  color: var(--color-amber-700);
  background: var(--color-amber-100);
  border-color: var(--color-amber-700);
}

/* One row of join-disclosure badges, flush with the content it qualifies. */
.badges {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin: var(--space-2) 0 0;
}

.pager {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-4);
}

.pager-summary {
  margin: 0 var(--space-2);
  color: var(--color-gray-900);
  font-size: 14px;
}

/* States */
.empty-state {
  padding: var(--space-8) var(--space-4);
  background: var(--color-background-100);
  border: 1px solid var(--color-gray-400);
  border-radius: var(--rounded-sm);
}

.notice {
  margin-top: var(--space-4);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-gray-400);
  border-radius: var(--rounded-sm);
  background: var(--color-background-100);
}

.notice[data-tone="error"] {
  color: var(--color-red-700);
  background: var(--color-red-100);
  border-color: var(--color-red-700);
}

.notice[data-tone="warning"] {
  color: var(--color-amber-700);
  background: var(--color-amber-100);
  border-color: var(--color-amber-700);
}

/* One fact per line inside a stale/unavailable disclosure notice. */
.notice-line {
  margin: 0;
  overflow-wrap: anywhere;
}

.notice-line + .notice-line {
  margin-top: var(--space-2);
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  border: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

/* Issues: detail */
.back-link {
  margin: 0 0 var(--space-4);
}

.back-link a {
  color: var(--color-blue-700);
}

.detail-id {
  margin: 0 0 var(--space-6);
  color: var(--color-gray-900);
}

.detail-section {
  margin-top: var(--space-8);
}

.heading-20 {
  font-size: 20px;
  font-weight: 600;
  line-height: 1.4;
  letter-spacing: -0.01em;
  margin: 0 0 var(--space-3);
}

.facts {
  margin: 0;
}

.fact {
  display: grid;
  grid-template-columns: minmax(120px, 200px) 1fr;
  gap: var(--space-2) var(--space-4);
  padding: var(--space-2) 0;
  border-top: 1px solid var(--color-gray-400);
}

.fact:first-child {
  border-top: none;
}

.fact-label {
  color: var(--color-gray-900);
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
}

.fact-value {
  margin: 0;
  font-size: 16px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.prose {
  margin: 0;
  font-size: 16px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.history,
.relations {
  margin: 0;
  padding: 0;
  list-style: none;
}

.history-item,
.relations > li {
  padding: var(--space-3) 0;
  border-top: 1px solid var(--color-gray-400);
}

.history-item:first-child,
.relations > li:first-child {
  border-top: none;
}

.history-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin: 0 0 var(--space-2);
}

.history-kind {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
}

.history-migration {
  margin: 0 0 var(--space-2);
  color: var(--color-gray-900);
  font-size: 14px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.evidence {
  margin: var(--space-2) 0 0;
  padding-left: var(--space-4);
}

.legacy-json {
  margin: var(--space-2) 0 0;
  padding: var(--space-3);
  background: var(--color-background-200);
  border-radius: var(--rounded-sm);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.external {
  margin: var(--space-2) 0 0;
}

.external a {
  color: var(--color-blue-700);
  overflow-wrap: anywhere;
}

/* Issues: issue-flow chart panel (D5) */
.flow-open {
  margin: 0 0 var(--space-2);
  font-size: 16px;
  line-height: 1.6;
}

.flow-scroll {
  margin-top: var(--space-2);
}

/* Fixed-pixel chart inside a labelled scroll region: below sm the region
   scrolls horizontally instead of scaling the axis text down (DESIGN.md
   "Spacing and responsive layout"). */
.flow-figure {
  margin: 0;
  padding: var(--space-3) var(--space-4);
  min-width: 720px;
}

.flow-chart {
  display: block;
}

.flow-line {
  stroke-width: 2.5;
  stroke-linecap: round;
}

.flow-line-captured {
  stroke: var(--color-blue-700);
}

.flow-line-retired {
  stroke: var(--color-purple-700);
}

.flow-axis {
  stroke: var(--color-gray-600);
  stroke-width: 1;
}

.flow-grid {
  stroke: var(--color-gray-400);
  stroke-width: 1;
  stroke-dasharray: 2 4;
}

.flow-axis-label {
  fill: var(--color-gray-900);
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.6;
}

.flow-legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-6);
  padding-top: var(--space-2);
  border-top: 1px solid var(--color-gray-400);
  color: var(--color-gray-900);
  font-size: 14px;
  line-height: 1.5;
}

.flow-legend-item {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.flow-legend-item svg {
  display: block;
}

.flow-note {
  margin-top: var(--space-2);
  max-width: 72ch;
}

/* Footer */
.app-footer {
  background: var(--color-background-100);
  border-top: 1px solid var(--color-gray-400);
  color: var(--color-gray-900);
  font-size: 14px;
  padding: var(--space-2) var(--space-8);
}

/* Focus visibility — never remove */
:focus-visible {
  outline: 2px solid var(--color-blue-700);
  outline-offset: 2px;
}

/* Responsive: below 768px, side padding drops to 16px */
@media (max-width: 767px) {
  .app-nav,
  .app-main,
  .app-footer {
    padding-left: var(--space-4);
    padding-right: var(--space-4);
  }
}

/* Below sm: secondary row metadata moves below the title instead of forcing a
   page-wide horizontal scroll (DESIGN.md "Spacing and responsive layout"). */
@media (max-width: 479px) {
  .col-secondary {
    display: none;
  }

  .row-meta {
    display: block;
    margin-top: var(--space-1);
    color: var(--color-gray-900);
    font-size: 14px;
    line-height: 1.5;
  }

  .filters {
    padding: var(--space-3);
  }

  .fact {
    grid-template-columns: 1fr;
    gap: var(--space-1);
  }
}

@media (prefers-reduced-motion: reduce) {
  * {
    transition: none !important;
  }
}
`;

// src/dashboard/server.ts
var DASHBOARD_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'";
var CLOSE_DRAIN_MS = 5000;
function fail(code, message) {
  return { error: { code, message } };
}
function statusForCode(code) {
  if (code === "usage")
    return 400;
  if (code === "issue.not-found" || code === "not-found")
    return 404;
  if (code.startsWith("store.") || code.startsWith("projection."))
    return 503;
  return 500;
}
function sendJson(res, status, body, requestHead) {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": DASHBOARD_CSP,
    "content-length": String(payload.byteLength)
  });
  res.end(requestHead ? undefined : payload);
}
function sendStatic(res, requestHead, contentType, body) {
  const payload = Buffer.from(body, "utf8");
  res.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": DASHBOARD_CSP,
    "content-length": String(payload.byteLength)
  });
  res.end(requestHead ? undefined : payload);
}
async function assertProjectExists(harnessDir, projectId) {
  const envelope = await readDashboardView({
    context: { harnessDir },
    view: "roadmap",
    params: { project: projectId }
  });
  if (envelope.data === null) {
    throw new Error(`Unknown project ${JSON.stringify(projectId)}: no catalog project row exists. ` + "Check the id with `mstar catalog list` and retry.");
  }
}
async function startDashboard(options) {
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`--port must be an integer between 0 and 65535 — got ${JSON.stringify(String(port))}`);
  }
  const context = { harnessDir: options.harnessDir };
  if (options.projectId !== undefined)
    await assertProjectExists(options.harnessDir, options.projectId);
  let closed = false;
  let tail = Promise.resolve();
  const enqueue = (work) => {
    if (closed)
      return Promise.reject(new Error("dashboard is shutting down"));
    const run = tail.then(work, work);
    tail = run.then(() => {
      return;
    }, () => {
      return;
    });
    return run;
  };
  const server = http.createServer((req, res) => {
    enqueue(() => handleRequest(req, res)).catch(() => {
      if (!res.headersSent)
        res.destroy();
    });
  });
  async function handleRequest(req, res) {
    const requestHead = req.method === "HEAD";
    const method = requestHead ? "GET" : req.method ?? "";
    const host = req.headers.host ?? "";
    const expectedHost = `127.0.0.1:${server.address().port}`;
    if (host !== expectedHost) {
      sendJson(res, 403, fail("forbidden", `Host header must be ${expectedHost}`), requestHead);
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${expectedHost}`) {
      sendJson(res, 403, fail("forbidden", `Origin ${JSON.stringify(origin)} is not the dashboard origin`), requestHead);
      return;
    }
    let url;
    try {
      url = new URL(req.url ?? "/", `http://${expectedHost}`);
    } catch {
      sendJson(res, 400, fail("usage", "the request path is not a valid URL"), requestHead);
      return;
    }
    const pathname = url.pathname;
    if (pathname === "/" || pathname === "/assets/app.js" || pathname === "/assets/app.css") {
      if (method !== "GET" && method !== "HEAD") {
        sendJson(res, 405, fail("method-not-allowed", "only GET and HEAD are accepted for static resources"), requestHead);
        return;
      }
      if (pathname === "/")
        sendStatic(res, requestHead, "text/html; charset=utf-8", dashboardHtml);
      else if (pathname === "/assets/app.js")
        sendStatic(res, requestHead, "text/javascript; charset=utf-8", dashboardJs);
      else
        sendStatic(res, requestHead, "text/css; charset=utf-8", dashboardCss);
      return;
    }
    try {
      const route = resolveDashboardRoute(pathname);
      if (route === null) {
        sendJson(res, 404, fail("not-found", `no dashboard route matches ${JSON.stringify(pathname)}`), requestHead);
        return;
      }
      if (req.method !== "GET") {
        sendJson(res, 405, fail("method-not-allowed", "the dashboard API is read-only: only GET is accepted"), requestHead);
        return;
      }
      const params = {};
      for (const key of new Set(url.searchParams.keys())) {
        params[key] = url.searchParams.get(key) ?? "";
      }
      const envelope = await readDashboardView({ context, view: route.view, params, id: route.id });
      if (envelope.data === null) {
        if (route.view === "workflow-detail" && envelope.projection.generation === null) {
          sendJson(res, 200, envelope, requestHead);
          return;
        }
        sendJson(res, 404, fail("not-found", "no such record"), requestHead);
        return;
      }
      sendJson(res, 200, envelope, requestHead);
    } catch (error) {
      const failure = dashboardFailure(error);
      const message = failure.message.split(options.harnessDir).join("{HARNESS_DIR}");
      sendJson(res, statusForCode(failure.code), fail(failure.code, message), requestHead);
    }
  }
  return await new Promise((resolve, reject) => {
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        reject(Object.assign(new Error(`Port ${port} is already in use on 127.0.0.1. Choose another --port or omit it for an OS-selected port.`), { code: error.code }));
        return;
      }
      reject(error);
    });
    server.listen(port, "127.0.0.1", () => {
      const actualPort = server.address().port;
      const query = options.projectId === undefined ? "" : `?${new URLSearchParams({ project: options.projectId }).toString()}`;
      const url = `http://127.0.0.1:${actualPort}/${query}`;
      let closePromise = null;
      resolve({
        url,
        close() {
          if (closePromise !== null)
            return closePromise;
          closed = true;
          closePromise = new Promise((resolveClose) => {
            const timer = setTimeout(() => server.closeAllConnections(), CLOSE_DRAIN_MS);
            server.close(() => {
              clearTimeout(timer);
              resolveClose();
            });
            server.closeIdleConnections();
          });
          return closePromise;
        }
      });
    });
  });
}
// src/definitions.ts
import { z as z21 } from "zod";

// src/families/status.ts
import { existsSync } from "node:fs";
import path from "node:path";
import {
  closeWorkflow,
  createFsStore,
  decodeExecutionSessionRef,
  executionContextFor,
  findingsCleanupGate,
  listIssues,
  mutateExecutionWorkflow,
  readExecutionAuthority,
  readJson,
  readWorkflowSnapshot,
  resolveExecutionReadRoute as resolveExecutionReadRoute2,
  resolveProcessHarnessDir,
  resolveWorkflowDir,
  setArtifactStore,
  unregisterWorkflow,
  validateStatusV2,
  WORKFLOW_SNAPSHOT_FILE
} from "@mstar-harness/engine";
import { z } from "zod";
var harnessInput = z.object({ harness: z.string().min(1).optional() });
function ok(command, data) {
  return { version: 1, command, status: "ok", code: "status.ok", exitCode: 0, data };
}
function refused(command, code, message, details) {
  return { version: 1, command, status: "refused", code, exitCode: 1, message, ...details === undefined ? {} : { details } };
}
function invalid(command, error) {
  return {
    version: 1,
    command,
    status: "usage",
    code: "command.invalid-input",
    exitCode: 2,
    message: error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")
  };
}
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
function engineCode(error, fallback) {
  if (error !== null && typeof error === "object" && "code" in error && typeof error.code === "string")
    return error.code;
  if (error !== null && typeof error === "object" && "violations" in error && Array.isArray(error.violations)) {
    const first = error.violations[0];
    if (first !== null && typeof first === "object" && "code" in first && typeof first.code === "string")
      return first.code;
  }
  return fallback;
}
function todayString() {
  const now = new Date;
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
function executionHarness(context, override) {
  return resolveProcessHarnessDir(context.cwd, override);
}
function command(definition) {
  return definition;
}
function getStatusCommandDefinitions() {
  const output = commandEnvelopeSchema;
  return [
    command({
      id: "status.validate",
      cli: { path: ["status", "validate"], aliases: [], arguments: [{ key: "path", required: false, variadic: false }], options: [] },
      input: z.object({ path: z.string().min(1).optional() }),
      output,
      effects: ["read", "validate"],
      description: "Validate the v2 status register or a workflow snapshot.",
      async execute(input, context) {
        const parsed = z.object({ path: z.string().min(1).optional() }).safeParse(input);
        if (!parsed.success)
          return invalid("status.validate", parsed.error);
        try {
          let target = parsed.data.path;
          if (target === undefined) {
            const harnessDir = executionHarness(context);
            if (harnessDir === null)
              return refused("status.validate", "status.harness-not-found", "Harness directory not found");
            if (await resolveExecutionReadRoute2({ harnessDir }) === "execution") {
              const read = await readExecutionAuthority({ harnessDir });
              return ok("status.validate", { authority: read.data, token: read.token, workflows: "workflows" in read.data ? read.data.workflows.map((entry) => ({ id: entry.state.id, token: entry.workflowToken })) : [] });
            }
            target = path.join(harnessDir, "status.json");
          } else {
            target = path.resolve(context.cwd, target);
            if (path.basename(target) === "status.json" && await resolveExecutionReadRoute2({ harnessDir: path.dirname(target) }) === "execution") {
              return refused("status.validate", "status.execution-authority-active", "The active execution authority must be validated through its authority reader");
            }
          }
          if (!existsSync(target))
            return refused("status.validate", "status.file-not-found", `status file not found: ${target}`);
          if (path.basename(target) === WORKFLOW_SNAPSHOT_FILE) {
            const read = readWorkflowSnapshot(path.dirname(target));
            return ok("status.validate", { path: target, diagnostics: read.diagnostics });
          }
          const gate = validateStatusV2(target);
          return gate.ok ? ok("status.validate", { path: target, violations: [] }) : refused("status.validate", gate.violations[0]?.code ?? "status.invalid", "Status validation failed", { violations: gate.violations });
        } catch (error) {
          return refused("status.validate", engineCode(error, "status.validation-failed"), messageOf(error));
        }
      }
    }),
    command({
      id: "status.workflow-close",
      cli: { path: ["status", "workflow-close"], aliases: [], arguments: [], options: [
        { key: "workflow", flags: "--workflow <id>", required: true },
        { key: "harness", flags: "--harness <path>", required: false },
        { key: "endedAt", flags: "--ended-at <date>", required: false },
        { key: "session", flags: "--session <path>", required: false },
        { key: "sessionRef", flags: "--session-ref <wire>", required: false },
        { key: "expect", flags: "--expect <token>", required: false },
        { key: "operation", flags: "--operation <id>", required: false },
        { key: "reason", flags: "--reason <text>", required: false },
        { key: "json", flags: "--json", required: false }
      ] },
      input: z.object({
        workflow: z.string().min(1),
        harness: z.string().min(1).optional(),
        endedAt: z.string().optional(),
        session: z.string().optional(),
        sessionRef: z.string().optional(),
        expect: z.string().optional(),
        operation: z.string().optional(),
        reason: z.string().optional(),
        json: z.boolean().optional()
      }),
      output,
      effects: ["write"],
      description: "Close a workflow only after engine lifecycle and delivery guards pass.",
      async execute(input, context) {
        const schema = z.object({
          workflow: z.string().min(1),
          harness: z.string().min(1).optional(),
          endedAt: z.string().optional(),
          session: z.string().optional(),
          sessionRef: z.string().optional(),
          expect: z.string().optional(),
          operation: z.string().optional(),
          reason: z.string().optional(),
          json: z.boolean().optional()
        });
        const parsed = schema.safeParse(input);
        if (!parsed.success)
          return invalid("status.workflow-close", parsed.error);
        const { workflow, harness, endedAt, session } = parsed.data;
        if (workflow === "." || workflow === ".." || workflow.includes("/") || workflow.includes("\\")) {
          return refused("status.workflow-close", "workflow.invalid-id", `invalid workflow id ${JSON.stringify(workflow)}`);
        }
        try {
          const harnessDir = executionHarness(context, harness);
          if (harnessDir === null)
            return refused("status.workflow-close", "status.harness-not-found", "Harness directory not found");
          const activeFields = [parsed.data.sessionRef, parsed.data.expect, parsed.data.operation];
          const activeRequested = activeFields.some((field) => field !== undefined);
          const active = await resolveExecutionReadRoute2({ harnessDir }) === "execution";
          if (activeRequested || active) {
            if (endedAt !== undefined || session !== undefined) {
              return { version: 1, command: "status.workflow-close", status: "usage", code: "command.invalid-input", exitCode: 2, message: "active execution close cannot combine --ended-at or --session with its CAS envelope" };
            }
            if (activeFields.some((field) => field === undefined) || parsed.data.reason === undefined || parsed.data.reason.trim() === "") {
              return { version: 1, command: "status.workflow-close", status: "usage", code: "command.invalid-input", exitCode: 2, message: "active execution close requires --session-ref, --expect, --operation, and --reason" };
            }
            if (context.sessionId === undefined || context.sessionId.trim() === "") {
              return refused("status.workflow-close", "coordination.identity-missing", "The invocation has no acquired main-session identity");
            }
            const executionContext = executionContextFor({ harnessDir }, { source: context.host === undefined ? "local" : "host", sessionId: context.sessionId, workflowId: workflow, role: "coordinator", planId: null });
            const receipt = await mutateExecutionWorkflow(executionContext, {
              workflowId: workflow,
              session: decodeExecutionSessionRef(parsed.data.sessionRef),
              expected: parsed.data.expect,
              operationId: parsed.data.operation,
              operation: { kind: "lifecycle", status: "completed", reason: parsed.data.reason }
            });
            return ok("status.workflow-close", receipt);
          }
          if (session !== undefined && !path.isAbsolute(session)) {
            return refused("status.workflow-close", "command.invalid-input", "--session must be an absolute path");
          }
          setArtifactStore(createFsStore(harnessDir));
          const snapshotDir = path.join(resolveWorkflowDir(harnessDir, { harnessDir }), workflow);
          const statusFile = path.join(harnessDir, "status.json");
          const closed = await closeWorkflow(workflow, snapshotDir, { endedAt: endedAt ?? todayString(), ...session ? { sessionPath: session } : {} });
          let hadRootEntry = false;
          try {
            const rootDoc = readJson(statusFile);
            hadRootEntry = Array.isArray(rootDoc.workflows) && rootDoc.workflows.some((entry) => entry?.id === workflow);
            await unregisterWorkflow(statusFile, workflow);
          } catch (error) {
            throw new Error(`partial close: snapshot ${workflow} is terminal (${closed.status}, ended_at ${closed.ended_at}) but its status.json entry remains — resolve the root and re-run the close (${messageOf(error)})`);
          }
          return ok("status.workflow-close", { snapshot: closed, unregistered: hadRootEntry, statusFile });
        } catch (error) {
          return refused("status.workflow-close", engineCode(error, "workflow.close-refused"), messageOf(error));
        }
      }
    }),
    command({
      id: "status.archive-residuals",
      cli: { path: ["status", "archive-residuals"], aliases: [], arguments: [], options: [] },
      input: z.object({}),
      output,
      effects: [],
      description: "Retired command; refuses without mutation.",
      async execute() {
        return refused("status.archive-residuals", "status.verb-retired", "status archive-residuals: removed — findings are issues in {HARNESS_DIR}/store.db; close one with `mstar plan issue-close` (plan-scoped) or `mstar issue close|waive|duplicate|supersede` (unscoped) instead");
      }
    }),
    command({
      id: "status.findings-cleanup",
      cli: { path: ["status", "findings-cleanup"], aliases: [], arguments: [{ key: "planId", required: true, variadic: false }], options: [
        { key: "harness", flags: "--harness <path>", required: false },
        { key: "mode", flags: "--mode <mode>", required: false }
      ] },
      input: z.object({ planId: z.string().min(1), harness: z.string().min(1).optional(), mode: z.enum(["zero-residual", "allow-residual"]).optional() }),
      output,
      effects: ["read", "validate"],
      description: "Enforce the findings-cleanup gate against the issue store.",
      async execute(input, context) {
        const schema = z.object({ planId: z.string().min(1), harness: z.string().min(1).optional(), mode: z.enum(["zero-residual", "allow-residual"]).optional() });
        const parsed = schema.safeParse(input);
        if (!parsed.success)
          return invalid("status.findings-cleanup", parsed.error);
        try {
          const harnessDir = executionHarness(context, parsed.data.harness) ?? parsed.data.harness ?? context.cwd;
          const gate = await findingsCleanupGate({ harnessDir }, parsed.data.planId, parsed.data.mode ? { mode: parsed.data.mode } : undefined);
          return gate.ok ? ok("status.findings-cleanup", { planId: parsed.data.planId, violations: [] }) : refused("status.findings-cleanup", gate.violations[0]?.code ?? "findings.cleanup-refused", "Findings cleanup gate failed", { violations: gate.violations });
        } catch (error) {
          return refused("status.findings-cleanup", engineCode(error, "findings.cleanup-refused"), messageOf(error));
        }
      }
    }),
    command({
      id: "status.tech-debt",
      cli: { path: ["status", "tech-debt"], aliases: [], arguments: [], options: [{ key: "harness", flags: "--harness <path>", required: false }] },
      input: harnessInput,
      output,
      effects: ["read"],
      description: "Read the open issue rollup from the issue store.",
      async execute(input, context) {
        const parsed = harnessInput.safeParse(input);
        if (!parsed.success)
          return invalid("status.tech-debt", parsed.error);
        try {
          const harnessDir = executionHarness(context, parsed.data.harness) ?? parsed.data.harness ?? context.cwd;
          const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
          const byProject = {};
          let totalOpen = 0;
          for (let offset = 0;; offset += 200) {
            const page = await listIssues({ harnessDir }, { disposition: "open", limit: 200, offset });
            totalOpen = page.total;
            for (const issue of page.items) {
              bySeverity[issue.severity] = (bySeverity[issue.severity] ?? 0) + 1;
              byProject[issue.projectId] = (byProject[issue.projectId] ?? 0) + 1;
            }
            if (page.items.length === 0 || offset + page.items.length >= page.total)
              break;
          }
          return ok("status.tech-debt", { total_open: totalOpen, by_severity: bySeverity, by_project: Object.fromEntries(Object.entries(byProject).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) });
        } catch (error) {
          return refused("status.tech-debt", engineCode(error, "issue.store-refused"), messageOf(error));
        }
      }
    }),
    ...[["backlog-register", "plan issue-add"], ["backlog-close", "plan issue-close"]].map(([verb, replacement]) => command({
      id: `status.${verb}`,
      cli: { path: ["status", verb], aliases: [], arguments: [], options: [] },
      input: z.object({}),
      output,
      effects: [],
      description: "Retired command; refuses without mutation.",
      async execute() {
        return refused(`status.${verb}`, "status.verb-retired", `status ${verb}: removed — project registers are migration history; findings are issues in {HARNESS_DIR}/store.db (capture/close via \`mstar ${replacement}\`, or the unscoped \`mstar issue add|close\`); this verb writes nothing`);
      }
    }))
  ];
}

// src/families/coordination-checks.ts
import { existsSync as existsSync2 } from "node:fs";
import path2 from "node:path";
import {
  applyMigratePlan,
  createFsStore as createFsStore2,
  evaluatePhaseGate,
  evaluatePostMergeClose,
  migrateHarnessTree,
  parseCompassFrontmatter,
  pushCadenceProbe,
  readExecutionSource,
  readJson as readJson2,
  resolveExecutionReadRoute as resolveExecutionReadRoute3,
  resolveProcessHarnessDir as resolveProcessHarnessDir2,
  resolveWorkflowDir as resolveWorkflowDir2,
  setArtifactStore as setArtifactStore2,
  StoreError as StoreError2,
  validateIntegrationMergeLease,
  validateProjectRegister,
  validateWorkflowSnapshot,
  verifyPlanExecutionLease,
  WORKFLOW_SNAPSHOT_FILE as WORKFLOW_SNAPSHOT_FILE2
} from "@mstar-harness/engine";
import { z as z2 } from "zod";
function leaseRow(view) {
  const plan = view.plan;
  return { ...plan, execution_lease: view.executionLease ?? undefined };
}
function ok2(command2, data) {
  return { version: 1, command: command2, status: "ok", code: `${command2}.ok`, exitCode: 0, data };
}
function refused2(command2, code, message, details) {
  return { version: 1, command: command2, status: "refused", code, exitCode: 1, message, ...details === undefined ? {} : { details } };
}
function usage(command2, message) {
  return { version: 1, command: command2, status: "usage", code: "command.invalid-input", exitCode: 2, message };
}
function messageOf2(error) {
  return error instanceof Error ? error.message : String(error);
}
function errorCode(error, fallback) {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : fallback;
}
function engineFailure(command2, error, fallback) {
  if (error instanceof z2.ZodError)
    return usage(command2, error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; "));
  return refused2(command2, errorCode(error, fallback), messageOf2(error));
}
function command2(definition) {
  return definition;
}
function harnessDir(context, override) {
  const resolved = resolveProcessHarnessDir2(context.cwd, override);
  if (!resolved)
    throw new Error(`harness dir not found from ${context.cwd} — pass harness or set MSTAR_HARNESS_DIR`);
  return resolved;
}
function assertWorkflowId(id) {
  if (id === "" || id === "." || id === ".." || id.includes("/") || id.includes("\\"))
    throw new Error(`invalid workflow id ${JSON.stringify(id)}`);
}
function snapshotPath(context, workflow, override) {
  assertWorkflowId(workflow);
  const root = harnessDir(context, override);
  return path2.join(resolveWorkflowDir2(root, { harnessDir: root }), workflow, WORKFLOW_SNAPSHOT_FILE2);
}
function solePlan(plans, label) {
  if (plans.length !== 1)
    throw new Error(`${label}: workflow snapshot has ${plans.length} plan rows — pass planId to pick one`);
  return plans[0];
}
function validatePlanDocs(plan) {
  const warnings = [];
  for (const snapshot of plan.snapshots) {
    const result = validateWorkflowSnapshot(snapshot.data);
    if (!result.ok)
      for (const item of result.violations)
        warnings.push(`[${item.severity}] ${item.code}: ${item.message} (planned snapshot ${snapshot.file})`);
  }
  if (plan.register !== null) {
    const result = validateProjectRegister(plan.register.data);
    if (!result.ok)
      for (const item of result.violations)
        warnings.push(`[${item.severity}] ${item.code}: ${item.message} (planned register ${plan.register.file})`);
  }
  return warnings;
}
function getCoordinationChecksCommandDefinitions() {
  const output = commandEnvelopeSchema;
  return [
    command2({
      id: "migrate",
      cli: { path: ["migrate"], aliases: [], arguments: [], options: [
        { key: "dryRun", flags: "--dry-run", required: false },
        { key: "path", flags: "--path <root>", required: false },
        { key: "deliveryKind", flags: "--delivery-kind <kind>", required: false },
        { key: "branchSource", flags: "--branch-source <branch>", required: false },
        { key: "branchTarget", flags: "--branch-target <branch>", required: false },
        { key: "completionPolicy", flags: "--completion-policy <text>", required: false },
        { key: "json", flags: "--json", required: false }
      ] },
      input: z2.object({ dryRun: z2.boolean().optional(), path: z2.string().optional(), deliveryKind: z2.string().optional(), branchSource: z2.string().optional(), branchTarget: z2.string().optional(), completionPolicy: z2.string().optional(), json: z2.boolean().optional() }),
      output,
      effects: ["read", "write"],
      description: "Migrate a v1 status tree using the engine migration plan.",
      async execute(input, context) {
        const id = "migrate";
        const root = input.path ? path2.resolve(context.cwd, input.path) : resolveProcessHarnessDir2(context.cwd) ?? context.cwd;
        try {
          setArtifactStore2(createFsStore2(root));
          const plan = migrateHarnessTree(root, {
            dryRun: input.dryRun === true,
            ...input.deliveryKind === undefined ? {} : { deliveryKind: input.deliveryKind },
            ...input.branchSource === undefined ? {} : { branchSource: input.branchSource },
            ...input.branchTarget === undefined ? {} : { branchTarget: input.branchTarget },
            ...input.completionPolicy === undefined ? {} : { completionPolicy: input.completionPolicy }
          });
          if (plan.alreadyMigrated)
            return ok2(id, { root, dryRun: plan.dryRun, alreadyMigrated: true, applied: false, message: plan.message, steps: plan.steps, migrationNotes: plan.migrationNotes });
          if (plan.deliveryKindAmbiguous.length > 0)
            return usage(id, `a single delivery declaration cannot describe ${plan.deliveryKindAmbiguous.length} active standalone plan lifts (${plan.deliveryKindAmbiguous.join(", ")}) — migrate them in batches of one declared plan`);
          if (plan.deliveryKindRequired.length > 0)
            return usage(id, `${plan.deliveryKindRequired.length} active standalone plan snapshot(s) would be lifted without a declared delivery kind (${plan.deliveryKindRequired.join(", ")}) — pass deliveryKind with its evidence (development: branchSource/branchTarget; verification/report-only: completionPolicy)`);
          if (plan.dryRun)
            return ok2(id, { root, dryRun: true, alreadyMigrated: false, applied: false, message: `dry-run: ${plan.steps.length} steps planned, zero writes`, steps: plan.steps, migrationNotes: plan.migrationNotes, roadmapCandidate: plan.roadmap, validationWarnings: validatePlanDocs(plan) });
          try {
            const result = await applyMigratePlan(plan);
            return ok2(id, { root, dryRun: false, alreadyMigrated: false, applied: result.applied, message: result.message, steps: plan.steps, migrationNotes: plan.migrationNotes, roadmapCandidate: plan.roadmap });
          } catch (error) {
            return { version: 1, command: id, status: "error", code: "migrate.apply-failure", exitCode: 2, message: messageOf2(error) };
          }
        } catch (error) {
          return engineFailure(id, error, "migrate.refused");
        }
      }
    }),
    command2({
      id: "lease.verify",
      cli: { path: ["lease", "verify"], aliases: [], arguments: [], options: [{ key: "workflow", flags: "--workflow <id>", required: true }, { key: "plan", flags: "--plan <plan-id>", required: false }, { key: "harness", flags: "--harness <path>", required: false }] },
      input: z2.object({ workflow: z2.string().min(1), plan: z2.string().optional(), harness: z2.string().optional() }),
      output,
      effects: ["read", "validate"],
      description: "Verify one workflow plan execution lease without mutation.",
      async execute(input, context) {
        const id = "lease.verify";
        try {
          const root = harnessDir(context, input.harness);
          const served = await readExecutionSource({ harnessDir: root }, input.plan === undefined ? { workflowId: input.workflow } : { workflowId: input.workflow, planId: input.plan });
          let rows;
          if (served.route === "execution") {
            const data = served.read.data;
            rows = input.plan === undefined ? (data.workflows[0]?.plans ?? []).map(leaseRow) : [leaseRow(served.read.data)];
          } else {
            const file = snapshotPath(context, input.workflow, input.harness);
            if (!existsSync2(file))
              return refused2(id, "lease.verify.snapshot-not-found", `workflow snapshot not found: ${file}`);
            const doc = readJson2(file);
            rows = Array.isArray(doc.plans) ? doc.plans : [];
          }
          const matches = input.plan === undefined ? [solePlan(rows, `lease verify ${input.workflow}`)] : rows.filter((row2) => row2.id === input.plan || row2.plan_id === input.plan);
          if (input.plan !== undefined && matches.length === 0)
            return refused2(id, "lease.verify.plan-not-found", `no plan row with id/plan_id ${input.plan}`);
          if (input.plan !== undefined && matches.length > 1)
            return refused2(id, "lease.verify.ambiguous", "multiple plan rows match (id and plan_id both present)");
          const row = matches[0];
          const planId = input.plan ?? String(row.plan_id ?? row.id ?? "");
          const result = verifyPlanExecutionLease(row, planId);
          return result.ok ? ok2(id, { workflow: input.workflow, plan: planId, lease: result.lease }) : refused2(id, result.violations[0]?.code ?? "lease.verify.invalid", result.violations.map((item) => `[${item.severity}] ${item.code}: ${item.message}`).join("; "), { violations: result.violations });
        } catch (error) {
          return engineFailure(id, error, "lease.verify.refused");
        }
      }
    }),
    command2({
      id: "lease.verify-integration",
      cli: { path: ["lease", "verify-integration"], aliases: [], arguments: [], options: [{ key: "workflow", flags: "--workflow <id>", required: true }, { key: "harness", flags: "--harness <path>", required: false }] },
      input: z2.object({ workflow: z2.string().min(1), harness: z2.string().optional() }),
      output,
      effects: ["read", "validate"],
      description: "Verify the workflow integration merge lease without mutation.",
      async execute(input, context) {
        const id = "lease.verify-integration";
        let lease;
        try {
          const root = harnessDir(context, input.harness);
          const served = await readExecutionSource({ harnessDir: root }, { workflowId: input.workflow });
          if (served.route === "execution")
            lease = served.read.data.workflows?.[0]?.integrationLease ?? undefined;
          else {
            const file = snapshotPath(context, input.workflow, input.harness);
            if (!existsSync2(file))
              return refused2(id, "lease.verify.snapshot-not-found", `workflow snapshot not found: ${file}`);
            lease = readJson2(file).integration_merge_lease;
          }
          if (lease === undefined)
            return ok2(id, { workflow: input.workflow, claimed: false });
          const result = validateIntegrationMergeLease(lease);
          return result.ok ? ok2(id, { workflow: input.workflow, claimed: true, lease }) : refused2(id, result.violations[0]?.code ?? "lease.merge-lease.invalid", result.violations.map((item) => `[${item.severity}] ${item.code}: ${item.message}`).join("; "), { violations: result.violations });
        } catch (error) {
          return engineFailure(id, error, "lease.verify-integration.refused");
        }
      }
    }),
    command2({
      id: "iteration.gate",
      cli: { path: ["iteration", "gate"], aliases: [], arguments: [], options: [{ key: "workflow", flags: "--workflow <id>", required: true }, { key: "compass", flags: "--compass <path>", required: false }, { key: "phase", flags: "--phase <n>", required: false }, { key: "harness", flags: "--harness <path>", required: false }, { key: "branch", flags: "--branch <branch>", required: false }, { key: "integration", flags: "--integration <branch>", required: false }, { key: "target", flags: "--target <branch>", required: false }] },
      input: z2.object({ workflow: z2.string().min(1), compass: z2.string().optional(), phase: z2.string().optional(), harness: z2.string().optional(), branch: z2.string().optional(), integration: z2.string().optional(), target: z2.string().optional() }),
      output,
      effects: ["read", "validate"],
      description: "Evaluate the iteration phase transition gate without mutation.",
      async execute(input, context) {
        const id = "iteration.gate";
        try {
          const phase6 = input.phase !== undefined && Number(input.phase) === 6;
          if (input.phase !== undefined && !phase6)
            return usage(id, `usage: iteration gate --phase only supports 6 (got ${JSON.stringify(input.phase)})`);
          if (!phase6 && (!input.compass || input.compass.trim() === ""))
            return usage(id, "usage: iteration gate requires --compass <path> (or --phase 6 for the post-merge close form)");
          const root = harnessDir(context, input.harness);
          if (await resolveExecutionReadRoute3({ harnessDir: root }) === "execution") {
            throw new StoreError2("execution.consumer-not-ready", `iteration gate: the execution authority of ${root} is ACTIVE, so this gate's snapshot/document input is retired. Nothing was read: this gate consumes a snapshot document whose plan rows carry their session binding (which the DB adapter deliberately does not), so it reports not-ready rather than inventing one. Read the workflow/plan state through the execution DB adapter instead.`);
          }
          const file = snapshotPath(context, input.workflow, input.harness);
          if (!existsSync2(file))
            return refused2(id, "iteration.gate.snapshot-not-found", `workflow snapshot not found: ${file}`);
          const snapshot = readJson2(file);
          if (phase6) {
            const root2 = harnessDir(context, input.harness);
            let rootDoc;
            try {
              const rootFile = path2.join(root2, "status.json");
              if (existsSync2(rootFile))
                rootDoc = readJson2(rootFile);
            } catch {
              rootDoc = undefined;
            }
            const gate2 = evaluatePostMergeClose(snapshot, rootDoc);
            return gate2.ok ? ok2(id, { phase: 6, gate: gate2 }) : refused2(id, gate2.violations[0]?.code ?? "iteration.gate.blocked", "phase 6 post-merge close gate is blocked", { gate: gate2 });
          }
          const compassPath = path2.resolve(context.cwd, input.compass);
          if (!existsSync2(compassPath))
            return refused2(id, "iteration.gate.compass-not-found", `compass file not found: ${compassPath}`);
          const gate = evaluatePhaseGate(snapshot, parseCompassFrontmatter(compassPath), { currentBranch: input.branch, specIntegrationBranch: input.integration, prBaseBranch: input.target });
          return gate.ok ? ok2(id, { transition: gate.transition, entry: gate.entry, exit: gate.exit }) : refused2(id, gate.violations[0]?.code ?? "iteration.gate.blocked", "iteration phase gate is blocked", { gate });
        } catch (error) {
          return engineFailure(id, error, "iteration.gate.refused");
        }
      }
    }),
    command2({
      id: "iteration.push-cadence",
      cli: { path: ["iteration", "push-cadence"], aliases: [], arguments: [], options: [{ key: "ciRunning", flags: "--ci-running", required: false }, { key: "reviewWave", flags: "--review-wave", required: false }] },
      input: z2.object({ ciRunning: z2.boolean().optional(), reviewWave: z2.boolean().optional() }),
      output,
      effects: ["validate"],
      description: "Probe whether CI and AI review activity permit a push.",
      async execute(input) {
        const id = "iteration.push-cadence";
        const gate = pushCadenceProbe(input.ciRunning === true, input.reviewWave === true);
        return gate.ok ? ok2(id, { allowed: true, violations: [] }) : refused2(id, gate.violations[0]?.code ?? "iteration.push-cadence.blocked", "push blocked by active CI or review wave", { violations: gate.violations });
      }
    })
  ];
}

// src/families/persist.ts
import { existsSync as existsSync3, readFileSync } from "node:fs";
import path3 from "node:path";
import {
  createFsStore as createFsStore3,
  getArtifactStore,
  loadStoreModule,
  readCoordinatedArtifact,
  replaceCoordinatedArtifact,
  resolveProcessHarnessDir as resolveProcessHarnessDir3,
  setArtifactStore as setArtifactStore3,
  validateMstarReviewV1,
  validateStatusV2 as validateStatusV22,
  validateWorkflowSnapshot as validateWorkflowSnapshot2
} from "@mstar-harness/engine";
import { z as z3 } from "zod";
var kinds = ["status", "snapshot", "review", "json"];
var kindSchema = z3.enum(kinds);
function ok3(command3, data) {
  return { version: 1, command: command3, status: "ok", code: "persist.ok", exitCode: 0, data };
}
function refused3(command3, code, message) {
  return { version: 1, command: command3, status: "refused", code, exitCode: 1, message };
}
function usage2(command3, message) {
  return { version: 1, command: command3, status: "usage", code: "command.invalid-input", exitCode: 2, message };
}
function messageOf3(error) {
  return error instanceof Error ? error.message : String(error);
}
function errorCode2(error, fallback) {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : fallback;
}
function validatePayload(kind, payload) {
  let gate;
  if (kind === "status")
    gate = validateStatusV22(payload);
  else if (kind === "snapshot")
    gate = validateWorkflowSnapshot2(payload);
  else if (kind === "review")
    gate = validateMstarReviewV1(payload);
  else
    return;
  if (!gate.ok)
    throw new Error(`refusing to persist invalid ${kind} document: ${gate.violations.map((v) => `[${v.severity}] ${v.code}: ${v.message}`).join("; ")}`);
}
async function resolveStore(storeFlag, cwd) {
  const modulePath = storeFlag ?? process.env.MSTAR_STORE_MODULE;
  if (modulePath !== undefined) {
    setArtifactStore3(await loadStoreModule(modulePath));
    return;
  }
  const harnessDir2 = resolveProcessHarnessDir3(cwd);
  if (harnessDir2 !== null)
    setArtifactStore3(createFsStore3(harnessDir2));
}
function parseKind(kind, command3) {
  const parsed = kindSchema.safeParse(kind);
  if (parsed.success)
    return parsed.data;
  if (kind === "residuals") {
    return refused3(command3, "persist.kind-retired", "persist residuals is retired; the issue store is the only findings authority");
  }
  return usage2(command3, "kind must be status, snapshot, review, or json");
}
function readPayload(input, file, cwd, command3) {
  if (input !== undefined && file !== undefined)
    return usage2(command3, "input and file are mutually exclusive");
  if (input !== undefined)
    return input;
  if (file === undefined)
    return usage2(command3, "provide input or file; protocol stdin is never read implicitly");
  const requested = path3.isAbsolute(file) ? file : path3.resolve(cwd, file);
  if (!existsSync3(requested))
    return refused3(command3, "persist.input-file-not-found", `persist payload file not found: ${requested}`);
  try {
    return readFileSync(requested, "utf8");
  } catch (error) {
    return refused3(command3, "persist.input-read-failed", messageOf3(error));
  }
}
function command3(definition) {
  return definition;
}
function isFailure(value) {
  return value !== null && typeof value === "object" && "status" in value && value.status !== "ok";
}
function getPersistCommandDefinitions() {
  const output = commandEnvelopeSchema;
  return [
    command3({
      id: "persist.write",
      cli: {
        path: ["persist"],
        aliases: [],
        arguments: [{ key: "kind", required: true, variadic: false }],
        options: [
          { key: "key", flags: "--key <key>", required: true },
          { key: "input", flags: "--input <json>", required: false },
          { key: "file", flags: "--file <path>", required: false },
          { key: "store", flags: "--store <module>", required: false },
          { key: "schema", flags: "--schema <id>", required: false },
          { key: "expectVersion", flags: "--expect-version <version>", required: false },
          { key: "session", flags: "--session <path>", required: false }
        ]
      },
      input: z3.object({ kind: z3.string(), key: z3.string().min(1), input: z3.string().optional(), file: z3.string().optional(), store: z3.string().optional(), schema: z3.string().optional(), expectVersion: z3.string().optional(), session: z3.string().optional() }),
      output,
      effects: ["write"],
      description: "Persist one JSON coordination document.",
      async execute(input, context) {
        const id = "persist.write";
        const kind = parseKind(input.kind, id);
        if (isFailure(kind))
          return kind;
        if (input.key === "")
          return usage2(id, "key must be non-empty");
        const raw = readPayload(input.input, input.file, context.cwd, id);
        if (typeof raw !== "string")
          return raw;
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch (error) {
          return refused3(id, "persist.invalid-json", `persist payload is not valid JSON: ${messageOf3(error)}`);
        }
        try {
          validatePayload(kind, payload);
          const coordinated = kind === "status" || kind === "snapshot";
          const sessionPath = input.session;
          if (coordinated && input.expectVersion === undefined)
            return usage2(id, `persist ${kind} requires expectVersion for coordinated replacement`);
          if (!coordinated && (input.expectVersion !== undefined || sessionPath !== undefined))
            return usage2(id, "expectVersion and session apply only to coordinated status/snapshot artifacts");
          if (coordinated && input.schema !== undefined)
            return usage2(id, `schema does not apply to coordinated ${kind} replacement`);
          if (kind === "snapshot" && sessionPath === undefined)
            return usage2(id, "coordinated snapshot replacement requires a coordinator session");
          if (sessionPath !== undefined && !path3.isAbsolute(sessionPath))
            return usage2(id, "session must be an absolute path");
          if (kind === "status" && sessionPath !== undefined)
            return usage2(id, "session applies to snapshot replacement only");
          await resolveStore(input.store, context.cwd);
          const store = getArtifactStore();
          if (coordinated) {
            const root = store.root;
            if (typeof root !== "string")
              return refused3(id, "coordination.local-store-required", "coordinated replacement requires the local FsStore");
            await replaceCoordinatedArtifact({
              harnessRoot: root,
              ref: { kind, key: input.key },
              payload,
              expectedVersion: input.expectVersion,
              ...sessionPath === undefined ? {} : { sessionPath }
            });
          } else {
            await store.put({ kind, key: input.key, payload, ...input.schema === undefined ? {} : { schema: input.schema } });
          }
          return ok3(id, { kind, key: input.key });
        } catch (error) {
          return refused3(id, errorCode2(error, "persist.write-refused"), messageOf3(error));
        }
      }
    }),
    command3({
      id: "persist.get",
      cli: { path: ["persist", "get"], aliases: [], arguments: [{ key: "kind", required: true, variadic: false }], options: [{ key: "key", flags: "--key <key>", required: true }, { key: "validate", flags: "--validate", required: false }, { key: "versioned", flags: "--versioned", required: false }, { key: "store", flags: "--store <module>", required: false }] },
      input: z3.object({ kind: z3.string(), key: z3.string().min(1), validate: z3.boolean().optional(), versioned: z3.boolean().optional(), store: z3.string().optional() }),
      output,
      effects: ["read"],
      description: "Read one persisted document.",
      async execute(input, context) {
        const id = "persist.get";
        const kind = parseKind(input.kind, id);
        if (isFailure(kind))
          return kind;
        try {
          await resolveStore(input.store, context.cwd);
          const store = getArtifactStore();
          if (input.versioned === true) {
            const root = store.root;
            if (typeof root !== "string")
              return refused3(id, "coordination.local-store-required", "versioned reads require the local FsStore");
            const read = await readCoordinatedArtifact(root, { kind, key: input.key });
            return ok3(id, { payload: read.payload ?? null, version: read.version });
          }
          const payload = await store.get({ kind, key: input.key });
          if (payload === undefined)
            return refused3(id, "persist.not-found", `persist get ${kind}/${input.key}: no stored document`);
          if (input.validate === true) {
            validatePayload(kind, payload);
            return ok3(id, { payload, validation: kind === "json" ? "parse-only" : "ok" });
          }
          return ok3(id, { payload });
        } catch (error) {
          return refused3(id, errorCode2(error, "persist.get-refused"), messageOf3(error));
        }
      }
    }),
    command3({
      id: "persist.list",
      cli: { path: ["persist", "list"], aliases: [], arguments: [{ key: "kind", required: true, variadic: false }], options: [{ key: "store", flags: "--store <module>", required: false }] },
      input: z3.object({ kind: z3.string(), store: z3.string().optional() }),
      output,
      effects: ["read"],
      description: "List persisted keys.",
      async execute(input, context) {
        const id = "persist.list";
        const kind = parseKind(input.kind, id);
        if (isFailure(kind))
          return kind;
        if (kind === "json")
          return usage2(id, "ArtifactStore json keys are absolute paths and cannot be listed");
        try {
          await resolveStore(input.store, context.cwd);
          const store = getArtifactStore();
          if (typeof store.list !== "function")
            return usage2(id, "store does not support list");
          const refs = await store.list(kind);
          return ok3(id, refs.map(({ key }) => key).sort());
        } catch (error) {
          return refused3(id, errorCode2(error, "persist.list-refused"), messageOf3(error));
        }
      }
    }),
    command3({
      id: "persist.delete",
      cli: { path: ["persist", "delete"], aliases: [], arguments: [{ key: "kind", required: true, variadic: false }], options: [{ key: "key", flags: "--key <key>", required: true }, { key: "store", flags: "--store <module>", required: false }] },
      input: z3.object({ kind: z3.string(), key: z3.string().min(1), store: z3.string().optional() }),
      output,
      effects: ["write"],
      description: "Delete one persisted document.",
      async execute(input, context) {
        const id = "persist.delete";
        const kind = parseKind(input.kind, id);
        if (isFailure(kind))
          return kind;
        try {
          await resolveStore(input.store, context.cwd);
          const store = getArtifactStore();
          if (typeof store.delete !== "function")
            return usage2(id, "store does not support delete");
          await store.delete({ kind, key: input.key });
          return ok3(id, { kind, key: input.key, deleted: true });
        } catch (error) {
          return refused3(id, errorCode2(error, "persist.delete-refused"), messageOf3(error));
        }
      }
    })
  ];
}

// src/families/plan.ts
import {
  bindPlanSession,
  bindExecutionSession,
  createFsStore as createFsStore4,
  decodeExecutionSessionRef as decodeExecutionSessionRef2,
  executionContextFor as executionContextFor2,
  mutateExecutionPlan,
  mutatePlanCoordination,
  readExecutionPlan,
  readPlanCoordination,
  resolveProcessHarnessDir as resolveProcessHarnessDir4,
  readSessionEnvelope,
  resumeExecutionSession,
  setArtifactStore as setArtifactStore4
} from "@mstar-harness/engine";
import { readFileSync as readFileSync2 } from "node:fs";
import path4 from "node:path";
import { z as z4 } from "zod";
var inputSchema = z4.object({
  session: z4.string().min(1).optional(),
  sessionRef: z4.string().min(1).optional(),
  resumeRef: z4.string().min(1).optional(),
  resume: z4.string().min(1).optional(),
  coordinator: z4.boolean().optional(),
  execution: z4.boolean().optional(),
  workflow: z4.string().min(1).optional(),
  plan: z4.string().min(1).optional(),
  assignment: z4.string().min(1).optional(),
  file: z4.string().min(1).optional(),
  harness: z4.string().min(1).optional(),
  expect: z4.union([z4.string().min(1), z4.number().int().nonnegative()]).optional(),
  operation: z4.string().min(1).optional(),
  sessionId: z4.string().min(1).optional(),
  handoff: z4.string().min(1).optional(),
  reason: z4.string().min(1).optional(),
  progress: z4.unknown().optional(),
  entries: z4.array(z4.unknown()).optional(),
  issue: z4.string().min(1).optional(),
  disposition: z4.enum(["resolved", "waived", "duplicate", "superseded"]).optional(),
  evidence: z4.unknown().optional(),
  expectIssue: z4.number().int().nonnegative().optional()
});
var optionKeys = Object.keys(inputSchema.shape);
var transitions = [
  ["accept", "Accept a submitted handoff and transfer execution ownership to the coordinator"],
  ["return", "Return a submitted or accepted handoff to the plan owner"],
  ["integration-start", "Record and pin an integration attempt before the operator performs Git merge"],
  ["integration-accept", "Verify the pinned Git result of a started integration attempt"],
  ["complete", "Record Done after verified delivery proof"],
  ["repair-delivery-source", "Replace a wrong registered delivery source from the accepted handoff pin"],
  ["reconcile", "Recover an interrupted integration attempt from the observed checkout"]
];
var PLAN_COORDINATOR_TRANSITIONS = transitions;
function ok4(id, data) {
  return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data };
}
function refused4(id, code, message) {
  return { version: 1, command: id, status: "refused", code, exitCode: 1, message };
}
function usage3(id, message) {
  return { version: 1, command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message };
}
function failure(id, error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : `${id}.internal-error`;
  return refused4(id, code, message);
}
function command4(definition) {
  return definition;
}
function absolutePath(value, key) {
  if (value === undefined || !path4.isAbsolute(value))
    throw new Error(`${key} must be an absolute path`);
  return value;
}
function expectedRevision(value) {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error("expect must be a nonnegative integer revision");
  return parsed;
}
function jsonObject(value, field) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${field} must be an object`);
  return value;
}
function payloadFromFile(file, field) {
  const absolute = absolutePath(file, field);
  return JSON.parse(readFileSync2(absolute, "utf8"));
}
function fileOperation(id, input) {
  switch (id) {
    case "plan.prepare":
      return { kind: "prepare", assignmentPath: absolutePath(input.assignment, "assignment") };
    case "plan.progress":
      return { kind: "progress", progress: jsonObject(input.progress ?? payloadFromFile(input.file, "file"), "progress") };
    case "plan.issue-add":
      const entries = input.entries ?? payloadFromFile(input.file, "file");
      if (!Array.isArray(entries))
        throw new Error("entries must be a JSON array");
      return { kind: "residual-add", entries };
    case "plan.issue-close":
      if (input.issue === undefined || input.disposition === undefined || input.expectIssue === undefined) {
        throw new Error("issue, disposition and expectIssue are required");
      }
      return {
        kind: "residual-close",
        issueId: input.issue,
        disposition: input.disposition,
        expectedIssueRevision: input.expectIssue,
        evidence: jsonObject(input.evidence ?? payloadFromFile(input.file, "file"), "file")
      };
    case "plan.handoff":
      return { kind: "handoff", evidence: jsonObject(input.evidence ?? payloadFromFile(input.file, "file"), "file") };
    case "plan.accept":
    case "plan.return":
    case "plan.integration-start":
    case "plan.integration-accept":
    case "plan.complete":
    case "plan.repair-delivery-source":
    case "plan.reconcile":
      if (input.handoff === undefined)
        throw new Error("handoff is required");
      if (id === "plan.return") {
        if (input.reason === undefined)
          throw new Error("reason is required for return");
        return { kind: "return", handoffId: input.handoff, reason: input.reason };
      }
      return { kind: id.slice("plan.".length), handoffId: input.handoff };
    default:
      throw new Error(`unsupported plan operation ${id}`);
  }
}
function pinSessionStore(sessionPath) {
  setArtifactStore4(createFsStore4(readSessionEnvelope(sessionPath).harness_root));
}
async function execute(id, input, context) {
  try {
    if (id === "plan.residual-add" || id === "plan.residual-close") {
      return refused4(id, "plan.verb-retired", `${id.replace(".", " ")}: retired; use the corresponding plan issue verb`);
    }
    if (id === "plan.bind") {
      const cwd = context.cwd;
      if (input.resumeRef !== undefined) {
        if (context.sessionId === undefined)
          return usage3(id, "active resume requires runtime session identity");
        const ref = decodeExecutionSessionRef2(input.resumeRef);
        const root = resolveProcessHarnessDir4(cwd, input.harness);
        if (root === null)
          return usage3(id, "no control harness resolved; supply an absolute harness");
        setArtifactStore4(createFsStore4(root));
        const identity = {
          source: context.host === undefined ? "local" : "host",
          sessionId: context.sessionId,
          workflowId: ref.workflowId,
          role: ref.role,
          planId: ref.planId
        };
        return ok4(id, await resumeExecutionSession(executionContextFor2({ harnessDir: root }, identity), ref));
      }
      if (input.execution === true) {
        if (context.sessionId === undefined || input.workflow === undefined || input.expect === undefined || input.operation === undefined) {
          return usage3(id, "active bind requires runtime session identity, workflow, full execution token and operation id");
        }
        const coordinator = input.coordinator === true;
        if (coordinator && input.plan !== undefined)
          return usage3(id, "coordinator bind accepts no plan");
        if (!coordinator && input.plan === undefined)
          return usage3(id, "active bind requires coordinator or plan");
        const role = coordinator ? "coordinator" : "plan-pm";
        const planId = coordinator ? null : input.plan;
        const root = resolveProcessHarnessDir4(cwd, input.harness);
        if (root === null)
          return usage3(id, "no control harness resolved; supply an absolute harness");
        setArtifactStore4(createFsStore4(root));
        const identity = {
          source: context.host === undefined ? "local" : "host",
          sessionId: context.sessionId,
          workflowId: input.workflow,
          role,
          planId
        };
        const receipt = await bindExecutionSession(executionContextFor2({ harnessDir: root }, identity), {
          workflowId: input.workflow,
          planId,
          role,
          expected: input.expect,
          operationId: input.operation
        });
        return ok4(id, receipt);
      }
      let bindInput;
      if (input.resume !== undefined) {
        const resumePath = absolutePath(input.resume, "resume");
        pinSessionStore(resumePath);
        bindInput = { resumePath, cwd };
      } else if (input.coordinator === true) {
        if (input.workflow === undefined)
          return usage3(id, "coordinator bind requires workflow");
        const root = resolveProcessHarnessDir4(cwd, input.harness);
        if (root !== null)
          setArtifactStore4(createFsStore4(root));
        bindInput = {
          coordinator: true,
          workflowId: input.workflow,
          cwd,
          ...input.harness !== undefined ? { harnessDir: absolutePath(input.harness, "harness") } : {},
          ...input.sessionId !== undefined ? { sessionId: input.sessionId } : {}
        };
      } else if (input.assignment !== undefined) {
        const root = resolveProcessHarnessDir4(cwd, input.harness);
        if (root !== null)
          setArtifactStore4(createFsStore4(root));
        bindInput = {
          scope: { assignmentPath: absolutePath(input.assignment, "assignment") },
          cwd,
          ...input.sessionId !== undefined ? { sessionId: input.sessionId } : {}
        };
      } else if (input.workflow !== undefined && input.plan !== undefined) {
        const root = resolveProcessHarnessDir4(cwd, input.harness);
        if (root !== null)
          setArtifactStore4(createFsStore4(root));
        bindInput = {
          scope: { workflowId: input.workflow, planId: input.plan, ...input.harness !== undefined ? { harnessDir: absolutePath(input.harness, "harness") } : {} },
          cwd,
          ...input.sessionId !== undefined ? { sessionId: input.sessionId } : {}
        };
      } else {
        return usage3(id, "bind requires a session, coordinator workflow, assignment, or workflow and plan");
      }
      return ok4(id, await bindPlanSession(bindInput));
    }
    if (id === "plan.show") {
      if (input.session !== undefined) {
        const sessionPath2 = absolutePath(input.session, "session");
        pinSessionStore(sessionPath2);
        return ok4(id, await readPlanCoordination(sessionPath2, input.plan, context.cwd));
      }
      if (input.sessionRef === undefined || input.plan === undefined || context.sessionId === undefined) {
        return usage3(id, "show requires a session file or sessionRef, plan selector, and runtime session identity");
      }
      const ref = decodeExecutionSessionRef2(input.sessionRef);
      const root = resolveProcessHarnessDir4(context.cwd, input.harness);
      if (root === null)
        return usage3(id, "no control harness resolved; supply an absolute harness");
      setArtifactStore4(createFsStore4(root));
      const identity = {
        source: context.host === undefined ? "local" : "host",
        sessionId: context.sessionId,
        workflowId: ref.workflowId,
        role: ref.role,
        planId: ref.planId
      };
      const result2 = await readExecutionPlan(executionContextFor2({ harnessDir: root }, identity), ref, input.plan);
      return ok4(id, result2);
    }
    const operation = fileOperation(id, input);
    if (input.sessionRef !== undefined) {
      if (context.sessionId === undefined || input.expect === undefined || typeof input.expect !== "string" || input.operation === undefined) {
        return usage3(id, "active operation requires runtime session identity, sessionRef, full execution token and operation id");
      }
      const ref = decodeExecutionSessionRef2(input.sessionRef);
      const planId = ref.planId ?? input.plan;
      if (planId === undefined)
        return usage3(id, "coordinator operation requires plan");
      const root = resolveProcessHarnessDir4(context.cwd, input.harness);
      if (root === null)
        return usage3(id, "no control harness resolved; supply an absolute harness");
      setArtifactStore4(createFsStore4(root));
      const identity = {
        source: context.host === undefined ? "local" : "host",
        sessionId: context.sessionId,
        workflowId: ref.workflowId,
        role: ref.role,
        planId: ref.planId
      };
      const receipt = await mutateExecutionPlan(executionContextFor2({ harnessDir: root }, identity), {
        operationId: input.operation,
        session: ref,
        expected: input.expect,
        planId,
        operation
      });
      return ok4(id, receipt);
    }
    if (input.session === undefined)
      return usage3(id, "operation requires session or active sessionRef");
    const sessionPath = absolutePath(input.session, "session");
    pinSessionStore(sessionPath);
    const result = await mutatePlanCoordination({
      sessionPath,
      ...input.plan !== undefined ? { planId: input.plan } : {},
      expectedRevision: expectedRevision(input.expect),
      operation
    });
    return ok4(id, result);
  } catch (error) {
    return failure(id, error);
  }
}
var writeCommands = {
  bind: true,
  prepare: true,
  progress: true,
  "issue-add": true,
  "issue-close": true,
  handoff: true,
  accept: true,
  return: true,
  "integration-start": true,
  "integration-accept": true,
  complete: true,
  "repair-delivery-source": true,
  reconcile: true,
  "residual-add": true,
  "residual-close": true
};
var commandNames = ["bind", "show", "prepare", "progress", "issue-add", "issue-close", "handoff", ...transitions.map(([verb]) => verb), "residual-add", "residual-close"];
function getPlanCommandDefinitions() {
  return commandNames.map((verb) => {
    const id = `plan.${verb}`;
    return command4({
      id,
      cli: {
        path: ["plan", verb],
        aliases: [],
        arguments: [],
        options: optionKeys.map((key) => ({ key, flags: `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} <value>`, required: false }))
      },
      input: inputSchema,
      output: commandEnvelopeSchema,
      effects: writeCommands[verb] === true ? ["write"] : ["read"],
      description: transitions.find(([name]) => name === verb)?.[1] ?? `Scoped plan ${verb} operation; engine enforces ownership, state and concurrency guards.`,
      execute: (input, context) => execute(id, input, context)
    });
  });
}

// src/families/session.ts
import { constants } from "node:os";
import { z as z5 } from "zod";
import {
  createFsStore as createFsStore5,
  createLocalExecutionIdentity,
  executionContextFor as executionContextFor3,
  recoverExecutionCoordinator,
  resolveProcessHarnessDir as resolveProcessHarnessDir5,
  serializeExecutionValue,
  setArtifactStore as setArtifactStore5
} from "@mstar-harness/engine";
var command5 = (definition) => definition;
var SESSION_ROLES = ["coordinator", "plan-pm"];
function ok5(id, data) {
  return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data };
}
function refused5(id, error) {
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : `${id}.refused`;
  return { version: 1, command: id, status: "refused", code, exitCode: 1, message: error instanceof Error ? error.message : String(error) };
}
function usage4(id, message) {
  return { version: 1, command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message };
}
function getSessionCommandDefinitions() {
  const runInput = z5.object({ workflow: z5.string().min(1), role: z5.enum(SESSION_ROLES), plan: z5.string().min(1).optional(), argv: z5.array(z5.string()).optional(), harness: z5.string().min(1).optional() });
  const recoverInput = z5.object({ workflow: z5.string().min(1), priorSession: z5.string().min(1).optional(), unowned: z5.boolean().optional(), reason: z5.string().min(1).optional(), attestation: z5.unknown().optional(), expect: z5.string().min(1).optional(), operation: z5.string().min(1).optional(), harness: z5.string().min(1).optional() });
  return [
    command5({
      id: "session.run",
      cli: { path: ["session", "run"], aliases: [], arguments: [{ key: "argv", required: true, variadic: true }], options: [
        { key: "workflow", flags: "--workflow <id>", required: true },
        { key: "role", flags: "--role <role>", required: true },
        { key: "plan", flags: "--plan <id>", required: false },
        { key: "harness", flags: "--harness <path>", required: false }
      ] },
      input: runInput,
      output: commandEnvelopeSchema,
      effects: ["process"],
      description: "Launch argv under a freshly minted local execution identity; this does not resume or bind a session.",
      async execute(raw, context) {
        const parsed = runInput.safeParse(raw);
        if (!parsed.success)
          return usage4("session.run", parsed.error.message);
        const { workflow, role, plan, argv = [], harness } = parsed.data;
        if (role === undefined || role === "plan-pm" && plan === undefined || role === "coordinator" && plan !== undefined || argv.length === 0 || argv[0].trim() === "") {
          return usage4("session.run", "session run requires --workflow, --role, a compatible --plan, and a child argv");
        }
        const root = resolveProcessHarnessDir5(context.cwd, harness);
        const identity = createLocalExecutionIdentity({ workflowId: workflow, role, planId: plan ?? null });
        const env = { ...process.env, MSTAR_EXECUTION_IDENTITY: serializeExecutionValue(identity) };
        delete env.MSTAR_HOST_SESSION_ID;
        if (root !== null)
          env.MSTAR_HARNESS_DIR = root;
        try {
          const child = await context.effects.spawn({ argv, cwd: context.cwd, env, signal: context.signal });
          const childCode = child.signal === null ? child.exitCode ?? 0 : 128 + (constants.signals[child.signal] ?? 0);
          if (childCode === 0)
            return ok5("session.run", { exitCode: childCode, signal: child.signal, stdout: child.stdout, stderr: child.stderr });
          return {
            version: 1,
            command: "session.run",
            status: "error",
            code: "session.child-exit",
            exitCode: childCode,
            message: child.signal === null ? `child exited with status ${childCode}` : `child terminated by ${child.signal}`,
            details: { signal: child.signal, stdout: child.stdout, stderr: child.stderr }
          };
        } catch (error) {
          return refused5("session.run", error);
        }
      }
    }),
    command5({
      id: "session.recover",
      cli: { path: ["session", "recover"], aliases: [], arguments: [], options: [
        { key: "workflow", flags: "--workflow <id>", required: true },
        { key: "priorSession", flags: "--prior-session <id>", required: false },
        { key: "unowned", flags: "--unowned", required: false },
        { key: "reason", flags: "--reason <text>", required: true },
        { key: "attestation", flags: "--attestation <path>", required: true },
        { key: "expect", flags: "--expect <token>", required: true },
        { key: "operation", flags: "--operation <id>", required: true },
        { key: "harness", flags: "--harness <path>", required: false }
      ] },
      input: recoverInput,
      output: commandEnvelopeSchema,
      effects: ["write"],
      description: "Recover a stopped workflow coordinator through active DB authority. Recovery never resumes a session.",
      async execute(raw, context) {
        const parsed = recoverInput.safeParse(raw);
        if (!parsed.success)
          return usage4("session.recover", parsed.error.message);
        const { workflow, priorSession, unowned, reason, attestation, expect, operation, harness } = parsed.data;
        if (priorSession === undefined === (unowned !== true) || reason === undefined || attestation === undefined || expect === undefined || operation === undefined) {
          return usage4("session.recover", "session recover requires exactly one of priorSession or unowned, reason, attestation, expect and operation");
        }
        if (context.sessionId === undefined)
          return usage4("session.recover", "active recovery requires the main conversation session identity");
        try {
          const root = resolveProcessHarnessDir5(context.cwd, harness);
          if (root === null)
            return usage4("session.recover", "no control harness resolved; supply an absolute harness");
          const identity = { source: context.host === undefined ? "local" : "host", sessionId: context.sessionId, workflowId: workflow, role: "coordinator", planId: null };
          setArtifactStore5(createFsStore5(root));
          const receipt = await recoverExecutionCoordinator(executionContextFor3({ harnessDir: root }, identity), {
            expected: expect,
            operationId: operation,
            priorSessionId: unowned ? null : priorSession,
            reason,
            attestation
          });
          return ok5("session.recover", receipt);
        } catch (error) {
          return refused5("session.recover", error);
        }
      }
    })
  ];
}

// src/families/workflow.ts
import { readFileSync as readFileSync3 } from "node:fs";
import path5 from "node:path";
import { z as z6 } from "zod";
import { randomUUID } from "node:crypto";
import {
  WORKFLOW_DELIVERY_KINDS as WORKFLOW_DELIVERY_KINDS2,
  WORKFLOW_LIFECYCLE_STATUSES,
  StoreError as StoreError3,
  amendPrepareWorkflow,
  commitExecutionRegistration,
  createFsStore as createFsStore6,
  decodeExecutionSessionRef as decodeExecutionSessionRef3,
  declareWorkflowDeliveryKind,
  executionContextFor as executionContextFor4,
  mutateExecutionWorkflow as mutateExecutionWorkflow2,
  readCatalogRevisions,
  readSessionEnvelope as readSessionEnvelope2,
  recoverPrepareCoordinator,
  recordWorkflowDelivery,
  registerShippedCatalogExecution,
  resolveExecutionReadRoute as resolveExecutionReadRoute4,
  resolveProcessHarnessDir as resolveProcessHarnessDir6,
  resolveWorkflowDir as resolveWorkflowDir3,
  setArtifactStore as setArtifactStore6,
  showPrepareWorkflow
} from "@mstar-harness/engine";
var transitions2 = [
  { name: "phase", effect: "write" },
  { name: "lifecycle", effect: "write" },
  { name: "execution-policy", effect: "write" },
  { name: "integration-worktree", effect: "write" }
];
function ok6(id, data) {
  return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data };
}
function usage5(id, message) {
  return { version: 1, command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message };
}
function refused6(id, error) {
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : `${id}.refused`;
  return { version: 1, command: id, status: "refused", code, exitCode: 1, message: error instanceof Error ? error.message : String(error) };
}
function object(value, field) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${field} must be an object`);
  return value;
}
function absolute(value, field) {
  if (value === undefined || !path5.isAbsolute(value))
    throw new Error(`${field} must be an absolute path`);
  return value;
}
async function assertLegacyRoute(harnessDir2, operation) {
  if (await resolveExecutionReadRoute4({ harnessDir: harnessDir2 }) === "execution") {
    throw new StoreError3("execution.consumer-not-ready", `${operation}: the execution authority of ${harnessDir2} is ACTIVE, so this pre-activation form is retired. ` + "Nothing was written; read the current token and use the active DB form under an independently acquired identity.");
  }
}
function schema() {
  return z6.object({
    workflow: z6.string().min(1).optional(),
    harness: z6.string().min(1).optional(),
    planId: z6.string().min(1).optional(),
    planTitle: z6.string().min(1).optional(),
    planFile: z6.string().min(1).optional(),
    deliveryKind: z6.string().min(1).optional(),
    project: z6.string().min(1).optional(),
    branchSource: z6.string().min(1).optional(),
    branchTarget: z6.string().min(1).optional(),
    completionPolicy: z6.string().min(1).optional(),
    startedAt: z6.string().min(1).optional(),
    expect: z6.string().min(1).optional(),
    operation: z6.string().min(1).optional(),
    file: z6.string().min(1).optional(),
    declareKind: z6.string().min(1).optional(),
    at: z6.string().min(1).optional(),
    session: z6.string().min(1).optional(),
    sessionRef: z6.string().min(1).optional(),
    sessionId: z6.string().min(1).optional(),
    priorSession: z6.string().min(1).optional(),
    reason: z6.string().min(1).optional(),
    stopped: z6.array(z6.string()).optional(),
    expectSnapshot: z6.string().min(1).optional(),
    expectCompass: z6.string().min(1).optional(),
    operationId: z6.string().min(1).optional(),
    authorizationRef: z6.string().min(1).optional(),
    input: z6.unknown().optional(),
    phase: z6.string().min(1).optional(),
    status: z6.string().min(1).optional(),
    path: z6.string().min(1).optional(),
    compass: z6.string().min(1).optional(),
    policy: z6.unknown().optional(),
    json: z6.boolean().optional(),
    row: z6.array(z6.unknown()).optional(),
    branchBase: z6.string().min(1).optional(),
    branchIntegration: z6.string().min(1).optional(),
    branchTargetIteration: z6.string().min(1).optional(),
    compassRef: z6.string().min(1).optional()
  });
}
function makeDefinition(id, description, effect, keys, execute2, contextOptions = []) {
  const input = schema().pick(Object.fromEntries(keys.map((key) => [key, true])));
  const optionNames = [...keys, ...contextOptions.map(({ key }) => key)];
  return {
    id,
    cli: {
      path: id.split("."),
      aliases: [],
      arguments: [],
      options: optionNames.map((key) => ({
        key,
        flags: `--${key.replace(/[A-Z]/g, (x) => `-${x.toLowerCase()}`)} <value>`,
        required: false,
        ...contextOptions.find((option) => option.key === key) ?? {}
      }))
    },
    input,
    output: commandEnvelopeSchema,
    effects: [effect],
    description,
    async execute(raw, context) {
      const parsed = input.safeParse(raw);
      if (!parsed.success)
        return usage5(id, parsed.error.message);
      return execute2(parsed.data, context);
    }
  };
}
function getWorkflowCommandDefinitions() {
  const commonRegister = ["workflow", "planId", "planTitle", "planFile", "deliveryKind", "project", "branchSource", "branchTarget", "completionPolicy", "startedAt", "harness", "expect", "operation", "json"];
  const defs = [
    makeDefinition("workflow.register", "Register a standalone plan workflow using create-only catalog registration and active DB CAS when selected.", "write", commonRegister, async (input, context) => {
      try {
        const required = [input.workflow, input.planId, input.planTitle, input.planFile, input.deliveryKind];
        if (required.some((value) => value === undefined || value.trim() === ""))
          return usage5("workflow.register", "workflow, planId, planTitle, planFile and deliveryKind are required");
        if (!WORKFLOW_DELIVERY_KINDS2.includes(input.deliveryKind))
          return usage5("workflow.register", `deliveryKind must be one of ${WORKFLOW_DELIVERY_KINDS2.join(" | ")}`);
        const harnessDir2 = resolveProcessHarnessDir6(context.cwd, input.harness);
        if (harnessDir2 === null)
          return usage5("workflow.register", "harness dir not found; supply harness");
        const workflow = { kind: "plan", workflowId: input.workflow, options: { harnessDir: harnessDir2, plan: { id: input.planId, title: input.planTitle, file: input.planFile }, deliveryKind: input.deliveryKind, ...input.project === undefined ? {} : { project: input.project }, ...input.branchSource === undefined ? {} : { branchSource: input.branchSource }, ...input.branchTarget === undefined ? {} : { branchTarget: input.branchTarget }, ...input.completionPolicy === undefined ? {} : { completionPolicy: input.completionPolicy }, ...input.startedAt === undefined ? {} : { startedAt: input.startedAt } } };
        setArtifactStore6(createFsStore6(harnessDir2));
        if (input.expect !== undefined || input.operation !== undefined) {
          if (input.expect === undefined || input.operation === undefined || context.sessionId === undefined)
            return usage5("workflow.register", "active registration requires main session identity, expect and operation");
          const identity = { source: context.host === undefined ? "local" : "host", sessionId: context.sessionId, workflowId: input.workflow, role: "coordinator", planId: null };
          const { catalogRevision } = await readCatalogRevisions({ harnessDir: harnessDir2 });
          return ok6("workflow.register", await commitExecutionRegistration(executionContextFor4({ harnessDir: harnessDir2 }, identity), { operationId: input.operation, actor: "mcp:workflow-register", expectedCatalogRevision: catalogRevision, workflow, delta: { entities: [{ kind: "plan", id: input.planId, title: input.planTitle, rootKind: "plans", relativePath: input.planFile }], binding: { catalogKind: "plan", catalogId: input.planId } }, expected: input.expect }));
        }
        await assertLegacyRoute(harnessDir2, "workflow register");
        return ok6("workflow.register", await registerShippedCatalogExecution({ harnessDir: harnessDir2 }, { operationId: randomUUID(), actor: "mcp:workflow-register", workflow }));
      } catch (error) {
        return refused6("workflow.register", error);
      }
    }),
    makeDefinition("workflow.evidence", "Record delivery evidence or one-time kind declaration; legacy file writes and active DB transitions stay disjoint.", "write", ["workflow", "file", "declareKind", "branchSource", "branchTarget", "completionPolicy", "session", "sessionRef", "expect", "operation", "at", "harness"], async (input, context) => {
      try {
        if (input.workflow === undefined)
          return usage5("workflow.evidence", "workflow is required");
        if (input.file === undefined === (input.declareKind === undefined))
          return usage5("workflow.evidence", "provide exactly one of file or declareKind");
        const root = resolveProcessHarnessDir6(context.cwd, input.harness);
        if (root === null)
          return usage5("workflow.evidence", "harness dir not found; supply harness");
        setArtifactStore6(createFsStore6(root));
        const workflowDir = path5.join(resolveWorkflowDir3(root, { harnessDir: root }), input.workflow);
        if (input.declareKind !== undefined) {
          if (input.sessionRef !== undefined || input.expect !== undefined || input.operation !== undefined)
            return usage5("workflow.evidence", "declareKind is pre-activation only");
          await assertLegacyRoute(root, "workflow evidence --declare-kind");
          const result = await declareWorkflowDeliveryKind(input.workflow, workflowDir, { deliveryKind: input.declareKind, ...input.branchSource === undefined ? {} : { branchSource: input.branchSource }, ...input.branchTarget === undefined ? {} : { branchTarget: input.branchTarget }, ...input.completionPolicy === undefined ? {} : { completionPolicy: input.completionPolicy }, ...input.session === undefined ? {} : { sessionPath: absolute(input.session, "session") }, ...input.at === undefined ? {} : { at: input.at } });
          return ok6("workflow.evidence", result);
        }
        const evidence = JSON.parse(readFileSync3(absolute(input.file, "file"), "utf8"));
        if (input.sessionRef !== undefined || input.expect !== undefined || input.operation !== undefined) {
          if (input.sessionRef === undefined || input.expect === undefined || input.operation === undefined || context.sessionId === undefined)
            return usage5("workflow.evidence", "active evidence requires main session identity, sessionRef, expect and operation");
          if (input.at !== undefined || input.session !== undefined)
            return usage5("workflow.evidence", "active evidence cannot use legacy session or at fields");
          const ref = decodeExecutionSessionRef3(input.sessionRef);
          const identity = { source: context.host === undefined ? "local" : "host", sessionId: context.sessionId, workflowId: ref.workflowId, role: ref.role, planId: ref.planId };
          return ok6("workflow.evidence", await mutateExecutionWorkflow2(executionContextFor4({ harnessDir: root }, identity), { workflowId: input.workflow, session: ref, expected: input.expect, operationId: input.operation, operation: { kind: "delivery", delivery: evidence } }));
        }
        await assertLegacyRoute(root, "workflow evidence");
        return ok6("workflow.evidence", await recordWorkflowDelivery(input.workflow, workflowDir, { evidence, ...input.session === undefined ? {} : { sessionPath: absolute(input.session, "session") }, ...input.at === undefined ? {} : { at: input.at } }));
      } catch (error) {
        return refused6("workflow.evidence", error);
      }
    }),
    makeDefinition("workflow.show-prepare", "Read the pre-activation Prepare workflow view from its coordinator session envelope.", "read", ["session"], async (input, context) => {
      try {
        if (input.session === undefined)
          return usage5("workflow.show-prepare", "session is required");
        return ok6("workflow.show-prepare", await showPrepareWorkflow({ sessionPath: absolute(input.session, "session"), cwd: context.cwd }));
      } catch (error) {
        return refused6("workflow.show-prepare", error);
      }
    }),
    makeDefinition("workflow.amend-prepare", "Append approved Prepare rows using legacy snapshot/compass byte-version CAS.", "write", ["session", "expectSnapshot", "expectCompass", "input"], async (input, context) => {
      try {
        if (input.session === undefined || input.expectSnapshot === undefined || input.expectCompass === undefined || input.input === undefined)
          return usage5("workflow.amend-prepare", "session, both expected versions and input patch are required");
        const sessionPath = absolute(input.session, "session");
        const envelope = readSessionEnvelope2(sessionPath);
        await assertLegacyRoute(envelope.harness_root, "workflow amend-prepare");
        return ok6("workflow.amend-prepare", await amendPrepareWorkflow({ sessionPath, cwd: context.cwd, expectedSnapshotVersion: input.expectSnapshot, expectedCompassVersion: input.expectCompass, patch: object(input.input, "input") }));
      } catch (error) {
        return refused6("workflow.amend-prepare", error);
      }
    }),
    makeDefinition("workflow.recover-coordinator", "Recover a pre-activation Prepare coordinator binding; this does not resume or transfer a lease.", "write", ["session", "expectSnapshot", "expectCompass", "operationId", "reason", "authorizationRef", "stopped"], async (input, context) => {
      try {
        if (input.session === undefined || input.expectSnapshot === undefined || input.expectCompass === undefined || input.operationId === undefined || input.reason === undefined || input.authorizationRef === undefined || input.stopped === undefined)
          return usage5("workflow.recover-coordinator", "all prior-session recovery assertions are required");
        if (context.sessionId === undefined || context.sessionId.trim() === "")
          return usage5("workflow.recover-coordinator", "recovery requires the main conversation session identity");
        const priorSessionPath = absolute(input.session, "session");
        const prior = readSessionEnvelope2(priorSessionPath);
        setArtifactStore6(createFsStore6(prior.harness_root));
        return ok6("workflow.recover-coordinator", await recoverPrepareCoordinator({
          cwd: context.cwd,
          harnessDir: prior.harness_root,
          identity: { source: context.host === undefined ? "local" : "host", sessionId: context.sessionId, workflowId: prior.workflow_id, role: "coordinator", planId: null },
          priorSessionPath,
          priorSessionId: prior.session_id,
          expectedSnapshotVersion: input.expectSnapshot,
          expectedCompassVersion: input.expectCompass,
          operationId: input.operationId,
          reason: input.reason,
          authorizationRef: input.authorizationRef,
          stoppedSessionIds: input.stopped
        }));
      } catch (error) {
        return refused6("workflow.recover-coordinator", error);
      }
    }, [{ key: "sessionId", context: "sessionId" }])
  ];
  for (const transition of transitions2) {
    const id = `workflow.${transition.name}`;
    defs.push(makeDefinition(id, `Apply the existing active workflow ${transition.name} transition under caller identity and full-token CAS.`, transition.effect, ["workflow", "sessionRef", "expect", "operation", "harness", "phase", "compass", "status", "reason", "file", "path"], async (input, context) => {
      try {
        if (input.workflow === undefined || input.sessionRef === undefined || input.expect === undefined || input.operation === undefined || context.sessionId === undefined)
          return usage5(id, "active workflow transition requires workflow, main session identity, sessionRef, full expect token and operation");
        const ref = decodeExecutionSessionRef3(input.sessionRef);
        if (ref.workflowId !== input.workflow)
          return usage5(id, "sessionRef workflow does not match workflow selector");
        const root = resolveProcessHarnessDir6(context.cwd, input.harness);
        if (root === null)
          return usage5(id, "no control harness resolved; supply an absolute harness");
        const operation = transition.name === "phase" ? input.phase === undefined || input.compass === undefined || !path5.isAbsolute(input.compass) ? (() => {
          throw new Error("phase requires phase and absolute compass");
        })() : { kind: "phase", phase: input.phase, compassPath: input.compass } : transition.name === "lifecycle" ? input.status === undefined || input.reason === undefined || !WORKFLOW_LIFECYCLE_STATUSES.includes(input.status) ? (() => {
          throw new Error("lifecycle requires a supported status and reason");
        })() : { kind: "lifecycle", status: input.status, reason: input.reason } : transition.name === "execution-policy" ? { kind: "execution-policy", policy: JSON.parse(readFileSync3(absolute(input.file, "file"), "utf8")) } : { kind: "integration-worktree", path: absolute(input.path, "path") };
        const identity = { source: context.host === undefined ? "local" : "host", sessionId: context.sessionId, workflowId: ref.workflowId, role: ref.role, planId: ref.planId };
        setArtifactStore6(createFsStore6(root));
        return ok6(id, await mutateExecutionWorkflow2(executionContextFor4({ harnessDir: root }, identity), { workflowId: input.workflow, session: ref, expected: input.expect, operationId: input.operation, operation }));
      } catch (error) {
        return refused6(id, error);
      }
    }));
  }
  defs.push(makeDefinition("iteration.register", "Register a create-only iteration workflow with its branch anchors and Todo rows.", "write", ["workflow", "compassRef", "branchBase", "branchIntegration", "branchTargetIteration", "row", "project", "startedAt", "harness", "expect", "operation"], async (input, context) => {
    try {
      if (input.workflow === undefined || input.compassRef === undefined || input.branchBase === undefined || input.branchIntegration === undefined || input.branchTargetIteration === undefined || input.row === undefined)
        return usage5("iteration.register", "workflow, compassRef, all branch anchors and rows are required");
      const harnessDir2 = resolveProcessHarnessDir6(context.cwd, input.harness);
      if (harnessDir2 === null)
        return usage5("iteration.register", "harness dir not found; supply harness");
      const workflow = { kind: "iteration", workflowId: input.workflow, options: { harnessDir: harnessDir2, compassRef: input.compassRef, branch: { base: input.branchBase, integration: input.branchIntegration, target: input.branchTargetIteration }, rows: input.row, ...input.project === undefined ? {} : { project: input.project }, ...input.startedAt === undefined ? {} : { startedAt: input.startedAt } } };
      setArtifactStore6(createFsStore6(harnessDir2));
      if (input.expect !== undefined || input.operation !== undefined) {
        if (input.expect === undefined || input.operation === undefined || context.sessionId === undefined)
          return usage5("iteration.register", "active registration requires main session identity, expect and operation");
        const identity = { source: context.host === undefined ? "local" : "host", sessionId: context.sessionId, workflowId: input.workflow, role: "coordinator", planId: null };
        const { catalogRevision } = await readCatalogRevisions({ harnessDir: harnessDir2 });
        return ok6("iteration.register", await commitExecutionRegistration(executionContextFor4({ harnessDir: harnessDir2 }, identity), { operationId: input.operation, actor: "mcp:iteration-register", expectedCatalogRevision: catalogRevision, workflow, delta: { entities: [{ kind: "iteration", id: input.workflow, title: input.workflow, rootKind: "iterations", relativePath: input.workflow }], binding: { catalogKind: "iteration", catalogId: input.workflow } }, expected: input.expect }));
      }
      await assertLegacyRoute(harnessDir2, "iteration register");
      return ok6("iteration.register", await registerShippedCatalogExecution({ harnessDir: harnessDir2 }, { operationId: randomUUID(), actor: "mcp:iteration-register", workflow }));
    } catch (error) {
      return refused6("iteration.register", error);
    }
  }));
  return defs;
}

// src/families/store.ts
import { existsSync as existsSync4, readdirSync, readFileSync as readFileSync4, writeFileSync } from "node:fs";
import path6 from "node:path";
import {
  SddScriptError as SddScriptError2,
  StoreError as StoreError4,
  activateStore,
  activationReceiptFor,
  appliedReceiptFor,
  applyStoreMigration,
  backupStore,
  initializeStore,
  planStoreMigration,
  resolveProcessHarnessDir as resolveProcessHarnessDir7,
  retireStoreSources,
  upgradeStore
} from "@mstar-harness/engine";
import { z as z7 } from "zod";
var inputSchema2 = z7.object({
  harness: z7.string().optional(),
  apply: z7.boolean().optional(),
  manifest: z7.string().optional(),
  attestation: z7.string().optional(),
  out: z7.string().optional()
});
var verbs = ["init", "migrate", "upgrade", "backup", "activate", "retire"];
var writeVerbs = { init: true, upgrade: true, backup: true, activate: true, retire: true };
function ok7(id, data) {
  return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data };
}
function refused7(id, error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : `${id}.internal-error`;
  if (error instanceof SddScriptError2)
    return { version: 1, command: id, status: "usage", code: "usage", exitCode: 2, message };
  return { version: 1, command: id, status: "refused", code, exitCode: 1, message };
}
function findLegacyWorkspaceFact(harnessDir2) {
  if (existsSync4(path6.join(harnessDir2, "store.db")))
    return `a store already exists at ${path6.join(harnessDir2, "store.db")} — migrate or activate instead of initializing`;
  const projectsDir = path6.join(harnessDir2, "projects");
  if (existsSync4(projectsDir)) {
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && existsSync4(path6.join(projectsDir, entry.name, "residuals.json"))) {
        return `legacy residual register found at projects/${entry.name}/residuals.json — use the staged migration, not "store init"`;
      }
    }
  }
  if (existsSync4(path6.join(harnessDir2, "iterations", "README.md")))
    return 'maintained catalog index found at iterations/README.md — use the staged migration, not "store init"';
  const statusPath = path6.join(harnessDir2, "status.json");
  if (existsSync4(statusPath)) {
    try {
      const status = JSON.parse(readFileSync4(statusPath, "utf8"));
      if (Array.isArray(status.workflows) && status.workflows.length > 0)
        return `${status.workflows.length} registered workflow(s) in status.json — this is not a genuinely empty workspace`;
    } catch {
      return `status.json at ${statusPath} is unreadable — this is not a genuinely empty workspace`;
    }
  }
  return null;
}
function contextOf(input, invocation) {
  const resolved = resolveProcessHarnessDir7(invocation.cwd, input.harness);
  const harnessDir2 = resolved ?? (input.harness === undefined ? invocation.cwd : path6.resolve(input.harness));
  if (invocation.controlRoot !== null && path6.resolve(harnessDir2) === path6.resolve(invocation.controlRoot)) {
    throw new SddScriptError2("store operations must name a fixture or project harness, never the control-root store", 2);
  }
  return { harnessDir: harnessDir2 };
}
function absoluteFile(value, flag) {
  if (!path6.isAbsolute(value))
    throw new SddScriptError2(`${flag} must be an absolute path`, 2);
  return value;
}
function outputPath(value, cwd) {
  return value === undefined ? undefined : path6.resolve(cwd, value);
}
function jsonFile(value, flag) {
  let text;
  try {
    text = readFileSync4(absoluteFile(value, flag), "utf8");
  } catch (error) {
    throw new SddScriptError2(`${flag} could not be read: ${error instanceof Error ? error.message : String(error)}`, 2);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new SddScriptError2(`${flag} is not valid JSON`, 2);
  }
}
function required(value, flag) {
  if (value === undefined || value.trim() === "")
    throw new SddScriptError2(`${flag} is required`, 2);
  return value;
}
async function execute2(id, input, invocation) {
  try {
    const context = contextOf(input, invocation);
    switch (id) {
      case "store.init": {
        const fact = findLegacyWorkspaceFact(context.harnessDir);
        if (fact !== null)
          throw new StoreError4("store.already-exists", `${fact}. Nothing was created.`);
        const handle = await initializeStore(context);
        try {
          return ok7(id, { storeId: handle.storeId, epoch: handle.epoch, schemaVersion: handle.schemaVersion, authorityState: "active" });
        } finally {
          handle.close();
        }
      }
      case "store.upgrade":
        return ok7(id, await upgradeStore(context));
      case "store.backup": {
        const out = outputPath(input.out, invocation.cwd);
        const receipt = await backupStore(context, out === undefined ? {} : { out });
        return ok7(id, { ...receipt, out: out ?? null });
      }
      case "store.migrate": {
        if (input.apply !== true && input.manifest !== undefined)
          throw new SddScriptError2("--manifest is only meaningful with --apply", 2);
        if (input.apply === true) {
          const manifest2 = required(input.manifest, "--manifest");
          const document = jsonFile(manifest2, "--manifest");
          if (document === null || typeof document !== "object" || document.version === undefined)
            throw new SddScriptError2("--manifest does not carry a MigrationManifest", 2);
          return ok7(id, await applyStoreMigration(context, document));
        }
        const manifest = await planStoreMigration(context);
        const out = outputPath(input.out, invocation.cwd);
        if (out !== undefined)
          writeFileSync(out, `${JSON.stringify(manifest, null, 2)}
`);
        return ok7(id, {
          controlRoot: manifest.controlRoot,
          sourceSetDigest: manifest.sourceSetDigest,
          sources: manifest.sources.map(({ project, relativePath, entryCount, sha256 }) => ({ project, relativePath, entryCount, sha256 })),
          mappings: manifest.mappings.length,
          unresolved: manifest.unresolved.length,
          catalogConflicts: manifest.catalog.conflicts.length,
          blocksApply: manifest.blocksApply,
          manifestFile: out ?? null,
          nextStep: manifest.blocksApply ? "resolve the unresolved mappings / catalog conflicts in review, then re-preview" : "have the manifest reviewed, then apply with --apply --manifest <path>"
        });
      }
      case "store.activate": {
        const manifest = jsonFile(required(input.manifest, "--manifest"), "--manifest");
        const attestation = jsonFile(required(input.attestation, "--attestation"), "--attestation");
        const applied = await appliedReceiptFor(context, manifest);
        const receipt = await activateStore(context, applied, attestation);
        const out = outputPath(input.out, invocation.cwd);
        if (out !== undefined)
          writeFileSync(out, `${JSON.stringify(receipt, null, 2)}
`);
        return ok7(id, { ...receipt, out: out ?? null });
      }
      case "store.retire": {
        const manifest = jsonFile(required(input.manifest, "--manifest"), "--manifest");
        const activation = await activationReceiptFor(context, manifest);
        const receipt = await retireStoreSources(context, activation);
        const out = outputPath(input.out, invocation.cwd);
        if (out !== undefined)
          writeFileSync(out, `${JSON.stringify(receipt, null, 2)}
`);
        return ok7(id, { ...receipt, out: out ?? null });
      }
      default:
        throw new Error(`unsupported store command ${id}`);
    }
  } catch (error) {
    return refused7(id, error);
  }
}
function cliDefinition(id) {
  const verb = id.slice("store.".length);
  const optionFlags = {
    harness: "--harness <path>",
    apply: "--apply",
    manifest: "--manifest <path>",
    attestation: "--attestation <path>",
    out: "--out <path>"
  };
  const optionsByVerb = {
    init: ["harness"],
    migrate: ["harness", "apply", "manifest", "out"],
    upgrade: ["harness"],
    backup: ["harness", "out"],
    activate: ["harness", "manifest", "attestation", "out"],
    retire: ["harness", "manifest", "out"]
  };
  const options = Object.keys(inputSchema2.shape).map((key) => ({ key, flags: optionFlags[key], required: false }));
  return {
    id,
    cli: { path: ["store", verb], aliases: [], arguments: [], options },
    input: inputSchema2,
    output: commandEnvelopeSchema,
    effects: verb === "migrate" ? ["read", "write"] : writeVerbs[verb] === true ? ["read", "write"] : ["read"],
    description: `Store ${verb} operation; engine enforces migration, activation, recovery and mutation barriers.`,
    execute: (input, invocation) => execute2(id, input, invocation)
  };
}
function getStoreCommandDefinitions() {
  return verbs.map((verb) => cliDefinition(`store.${verb}`));
}

// src/families/execution.ts
import { readFileSync as readFileSync5, writeFileSync as writeFileSync2 } from "node:fs";
import path7 from "node:path";
import {
  SddScriptError as SddScriptError3,
  abortExecutionMigration,
  activateExecutionMigration,
  applyExecutionMigration,
  collectExecutionCoverage,
  executionManifestHash,
  exportExecutionState,
  previewExecutionMigration,
  previewExecutionRestore,
  restoreExecutionBackup,
  retireExecutionSources,
  resolveProcessHarnessDir as resolveProcessHarnessDir8
} from "@mstar-harness/engine";
import { z as z8 } from "zod";
var inputSchema3 = z8.object({
  harness: z8.string().optional(),
  operation: z8.string().optional(),
  operator: z8.string().optional(),
  inventory: z8.string().optional(),
  out: z8.string().optional(),
  coverageOut: z8.string().optional(),
  manifest: z8.string().optional(),
  coverage: z8.string().optional(),
  backup: z8.string().optional(),
  attestation: z8.string().optional(),
  reason: z8.string().optional(),
  preview: z8.string().optional(),
  acceptLossDigest: z8.string().optional(),
  authorization: z8.string().optional()
});
var verbs2 = ["preview", "apply", "activate", "retire", "abort", "restore-preview", "restore", "export"];
var writeVerbs2 = { apply: true, activate: true, retire: true, abort: true, restore: true };
var lossDigestPattern = /^[0-9a-f]{64}$/;
function ok8(id, data) {
  return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data };
}
function refused8(id, error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : `${id}.internal-error`;
  return error instanceof SddScriptError3 ? { version: 1, command: id, status: "usage", code: "usage", exitCode: 2, message } : { version: 1, command: id, status: "refused", code, exitCode: 1, message };
}
function required2(value, flag) {
  if (value === undefined || value.trim() === "")
    throw new SddScriptError3(`${flag} is required`, 2);
  return value.trim();
}
function absolute2(value, flag, optional = false) {
  if (value === undefined || optional && value.trim() === "")
    return;
  if (!path7.isAbsolute(value))
    throw new SddScriptError3(`${flag} must be an absolute path`, 2);
  return value;
}
function readJson3(value, flag) {
  const file = absolute2(required2(value, flag), flag);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync5(file, "utf8"));
  } catch (error) {
    throw new SddScriptError3(`${flag} could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`, 2);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new SddScriptError3(`${flag} must contain a JSON object`, 2);
  return parsed;
}
function executionContext(input, invocation, verb) {
  const harness = absolute2(input.harness, "--harness");
  const root = resolveProcessHarnessDir8(invocation.cwd, harness);
  if (root === null)
    throw new SddScriptError3(`${verb}: no target harness was resolved; pass --harness <absolute-path>`, 2);
  if (invocation.controlRoot !== null && path7.resolve(root) === path7.resolve(invocation.controlRoot)) {
    throw new SddScriptError3(`${verb}: the control-root store is not an admitted execution target`, 2);
  }
  return { harnessDir: root };
}
function document(value, flag) {
  return readJson3(value, flag);
}
function reviewedInventory(manifest, input, verb) {
  const supplied = absolute2(input.inventory, "--inventory", true);
  const expected = "inventoryPath" in manifest ? manifest.inventoryPath : null;
  if (expected === null) {
    if (supplied !== undefined)
      throw new SddScriptError3(`${verb}: this reviewed manifest has no explicit inventory`, 2);
    return;
  }
  if (supplied === undefined || supplied !== expected)
    throw new SddScriptError3(`${verb}: --inventory must match the manifest's reviewed discovery scope`, 2);
  return supplied;
}
function coverageSet(input, manifest, verb) {
  const set = document(input.coverage, "--coverage");
  if (set.version !== 1 || !Array.isArray(set.receipts) || typeof set.digest !== "string" || !lossDigestPattern.test(set.digest)) {
    throw new SddScriptError3(`${verb}: --coverage is not a canonical execution coverage set`, 2);
  }
  if (set.manifestId !== manifest.id || set.manifestHash !== executionManifestHash(manifest)) {
    throw new SddScriptError3(`${verb}: --coverage belongs to a different reviewed manifest`, 2);
  }
  return set;
}
function requireDigest(input) {
  const digest = required2(input.acceptLossDigest, "--accept-loss-digest");
  if (!lossDigestPattern.test(digest))
    throw new SddScriptError3("--accept-loss-digest must be the exact 64-hex lossDigest", 2);
  return digest;
}
async function execute3(id, input, invocation) {
  try {
    const verb = id.slice("store.execution.".length);
    const context = executionContext(input, invocation, `store execution ${verb}`);
    if (verb === "preview") {
      const operationId = required2(input.operation, "--operation");
      const operator = required2(input.operator, "--operator");
      const inventoryPath = absolute2(input.inventory, "--inventory", true);
      const out = absolute2(input.out, "--out", true);
      const coverageOut = absolute2(input.coverageOut, "--coverage-out", true);
      if (coverageOut !== undefined && inventoryPath === undefined)
        throw new SddScriptError3("--coverage-out requires --inventory", 2);
      const manifest = await previewExecutionMigration({ context, operationId, operator, ...inventoryPath === undefined ? {} : { inventoryPath } });
      if (out !== undefined)
        writeFileSync2(out, `${JSON.stringify(manifest, null, 2)}
`);
      let coverage;
      if (coverageOut !== undefined && inventoryPath !== undefined) {
        coverage = await collectExecutionCoverage({ context, operationId, operator, inventoryPath, manifest });
        writeFileSync2(coverageOut, `${JSON.stringify(coverage, null, 2)}
`);
      }
      return ok8(id, {
        version: manifest.version,
        manifestId: manifest.id,
        manifestHash: executionManifestHash(manifest),
        storeId: manifest.storeId,
        epoch: manifest.epoch,
        schemaVersion: manifest.schemaVersion,
        root: manifest.root,
        inventoryPath: manifest.inventoryPath ?? null,
        sources: manifest.sources.length,
        surfaces: manifest.surfaces.length,
        deferred: manifest.deferred.length,
        manifestFile: out ?? null,
        coverageDigest: coverage?.digest ?? null,
        coverageFile: coverage === undefined ? null : coverageOut
      });
    }
    if (verb === "apply") {
      const operationId = required2(input.operation, "--operation");
      const operator = required2(input.operator, "--operator");
      const reviewed = document(input.manifest, "--manifest");
      if (reviewed.version !== 2)
        throw new SddScriptError3("apply requires the version 2 execution manifest", 2);
      const manifest = reviewed;
      const inventoryPath = reviewedInventory(manifest, input, verb);
      const coverage = coverageSet(input, manifest, verb);
      const backup = document(input.backup, "--backup");
      if (typeof backup.backupPath !== "string" || backup.backupPath.trim() === "")
        throw new SddScriptError3("--backup must be the recovery-point receipt", 2);
      const manifestHash = executionManifestHash(manifest);
      const receipt = await applyExecutionMigration({ context, operationId, operator, ...inventoryPath === undefined ? {} : { inventoryPath }, manifest, manifestHash, backup, coverage });
      return ok8(id, { ...receipt, manifestHash, coverageDigest: coverage.digest });
    }
    if (verb === "activate") {
      const operationId = required2(input.operation, "--operation");
      const operator = required2(input.operator, "--operator");
      const manifest = document(input.manifest, "--manifest");
      const inventoryPath = reviewedInventory(manifest, input, verb);
      const coverage = coverageSet(input, manifest, verb);
      const attestation = document(input.attestation, "--attestation");
      const manifestHash = executionManifestHash(manifest);
      const receipt = await activateExecutionMigration({ context, operationId, operator, ...inventoryPath === undefined ? {} : { inventoryPath }, manifestId: manifest.id, manifestHash, expectedEpoch: manifest.epoch, attestation, coverageDigest: coverage.digest });
      return ok8(id, { ...receipt, manifestHash, expectedEpoch: manifest.epoch, coverageDigest: coverage.digest });
    }
    if (verb === "retire") {
      const operationId = required2(input.operation, "--operation");
      const operator = required2(input.operator, "--operator");
      const manifest = document(input.manifest, "--manifest");
      const inventoryPath = reviewedInventory(manifest, input, verb);
      const manifestHash = executionManifestHash(manifest);
      const receipt = await retireExecutionSources({ context, operationId, operator, ...inventoryPath === undefined ? {} : { inventoryPath }, manifestId: manifest.id, manifestHash });
      return ok8(id, { ...receipt, manifestHash });
    }
    if (verb === "abort") {
      const operationId = required2(input.operation, "--operation");
      const operator = required2(input.operator, "--operator");
      const reason = required2(input.reason, "--reason");
      const manifest = document(input.manifest, "--manifest");
      const manifestHash = executionManifestHash(manifest);
      const receipt = await abortExecutionMigration({ context, operationId, operator, manifestId: manifest.id, manifestHash, reason });
      return ok8(id, { ...receipt, manifestHash });
    }
    if (verb === "restore-preview") {
      const backupPath = absolute2(required2(input.backup, "--backup"), "--backup");
      const preview = await previewExecutionRestore(context, backupPath);
      const out = absolute2(input.out, "--out", true);
      if (out !== undefined)
        writeFileSync2(out, `${JSON.stringify(preview, null, 2)}
`);
      return ok8(id, { ...preview, previewFile: out ?? null });
    }
    if (verb === "restore") {
      const operator = required2(input.operator, "--operator");
      const authorization = required2(input.authorization, "--authorization");
      const preview = document(input.preview, "--preview");
      if (typeof preview.lossDigest !== "string" || !lossDigestPattern.test(preview.lossDigest))
        throw new SddScriptError3("--preview carries no canonical loss digest", 2);
      const acceptLossDigest = requireDigest(input);
      const receipt = await restoreExecutionBackup(context, { preview, acceptLossDigest, operator, authorization });
      const out = absolute2(input.out, "--out", true);
      if (out !== undefined)
        writeFileSync2(out, `${JSON.stringify(receipt, null, 2)}
`);
      return ok8(id, { ...receipt, receiptFile: out ?? null });
    }
    if (verb === "export") {
      const artifact = await exportExecutionState(context);
      const out = absolute2(input.out, "--out", true);
      if (out !== undefined)
        writeFileSync2(out, artifact.canonicalJson.endsWith(`
`) ? artifact.canonicalJson : `${artifact.canonicalJson}
`);
      return ok8(id, { format: artifact.format, sha256: artifact.sha256, out: out ?? null, canonicalJson: artifact.canonicalJson });
    }
    throw new Error(`unsupported store execution command ${id}`);
  } catch (error) {
    return refused8(id, error);
  }
}
function cliDefinition2(id) {
  const verb = id.slice("store.execution.".length);
  const flags = {
    harness: "--harness <path>",
    operation: "--operation <id>",
    operator: "--operator <name>",
    inventory: "--inventory <path>",
    out: "--out <path>",
    coverageOut: "--coverage-out <path>",
    manifest: "--manifest <path>",
    coverage: "--coverage <path>",
    backup: "--backup <path>",
    attestation: "--attestation <path>",
    reason: "--reason <text>",
    preview: "--preview <path>",
    acceptLossDigest: "--accept-loss-digest <hex>",
    authorization: "--authorization <ref>"
  };
  const options = Object.keys(inputSchema3.shape).map((key) => ({ key, flags: flags[key], required: false }));
  return {
    id,
    cli: { path: ["store", "execution", verb], aliases: [], arguments: [], options },
    input: inputSchema3,
    output: commandEnvelopeSchema,
    effects: writeVerbs2[verb] === true ? ["read", "write"] : verb === "preview" ? ["read", "write"] : ["read"],
    description: `Store execution ${verb} operation; engine enforces reviewed migration and recovery barriers.`,
    execute: (input, invocation) => execute3(id, input, invocation)
  };
}
function getExecutionCommandDefinitions() {
  return verbs2.map((verb) => cliDefinition2(`store.execution.${verb}`));
}

// src/families/issue.ts
import { readFileSync as readFileSync6 } from "node:fs";
import path8 from "node:path";
import {
  appendOccurrence,
  captureIssue,
  closeIssue,
  getIssue,
  linkIssue,
  listIssues as listIssues2,
  resolveProcessHarnessDir as resolveProcessHarnessDir9,
  triageIssue
} from "@mstar-harness/engine";
import { z as z9 } from "zod";
var inputSchema4 = z9.object({
  id: z9.string().optional(),
  project: z9.string().optional(),
  disposition: z9.enum(["open", "resolved", "waived", "duplicate", "superseded"]).optional(),
  kind: z9.enum(["bug", "risk", "improvement", "request", "decision", "review-obligation"]).optional(),
  severity: z9.enum(["critical", "high", "medium", "low", "info"]).optional(),
  query: z9.string().optional(),
  limit: z9.number().int().positive().max(200).optional(),
  offset: z9.number().int().nonnegative().optional(),
  harness: z9.string().optional(),
  file: z9.string().optional(),
  operationId: z9.string().optional(),
  actor: z9.string().optional(),
  session: z9.string().optional(),
  expect: z9.number().int().nonnegative().optional(),
  payload: z9.unknown().optional()
});
var verbs3 = ["add", "list", "show", "occurrence", "triage", "close", "waive", "duplicate", "supersede", "link", "export"];
var terminalDisposition = {
  close: "resolved",
  waive: "waived",
  duplicate: "duplicate",
  supersede: "superseded"
};
var readVerbs = { list: true, show: true, export: true };
function ok9(id, data) {
  return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data };
}
function refused9(id, error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : `${id}.internal-error`;
  return { version: 1, command: id, status: "refused", code, exitCode: 1, message };
}
function storeContext(input, invocation) {
  const root = resolveProcessHarnessDir9(invocation.cwd, input.harness);
  return { harnessDir: root ?? input.harness ?? invocation.controlRoot ?? invocation.cwd };
}
function mutation(input, privileged) {
  if (input.operationId === undefined || input.actor === undefined)
    throw new Error("operationId and actor are required for issue mutation");
  return {
    operationId: input.operationId,
    actor: input.actor,
    ...privileged && input.session !== undefined ? { sessionFile: input.session } : {},
    ...privileged && input.expect !== undefined ? { expectedRevision: input.expect } : {}
  };
}
function payload(input) {
  let value = input.payload;
  if (value === undefined && input.file !== undefined) {
    if (!path8.isAbsolute(input.file))
      throw new Error("file must be an absolute path");
    value = JSON.parse(readFileSync6(input.file, "utf8"));
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("payload must be an object");
  return value;
}
function requiredId(input) {
  if (input.id === undefined || input.id.trim() === "")
    throw new Error("issue id is required");
  return input.id.trim();
}
function issueFilter(input) {
  return {
    ...input.project !== undefined ? { projectId: input.project } : {},
    ...input.disposition !== undefined ? { disposition: input.disposition } : {},
    ...input.kind !== undefined ? { kind: input.kind } : {},
    ...input.severity !== undefined ? { severity: input.severity } : {},
    ...input.query !== undefined ? { query: input.query } : {},
    ...input.limit !== undefined ? { limit: input.limit } : {},
    ...input.offset !== undefined ? { offset: input.offset } : {}
  };
}
async function execute4(id, input, invocation) {
  try {
    const context = storeContext(input, invocation);
    if (id === "issue.list" || id === "issue.export") {
      const page = await listIssues2(context, issueFilter(input));
      if (id === "issue.export" && input.id !== undefined && input.id.trim() !== "")
        return ok9(id, await getIssue(context, input.id.trim()));
      return ok9(id, page);
    }
    if (id === "issue.show")
      return ok9(id, await getIssue(context, requiredId(input)));
    if (id === "issue.add")
      return ok9(id, await captureIssue(context, payload(input), mutation(input, false)));
    if (id === "issue.occurrence")
      return ok9(id, await appendOccurrence(context, requiredId(input), payload(input), mutation(input, false)));
    if (id === "issue.triage")
      return ok9(id, await triageIssue(context, requiredId(input), payload(input), mutation(input, true)));
    const disposition = terminalDisposition[id.slice("issue.".length)];
    if (disposition !== undefined)
      return ok9(id, await closeIssue(context, requiredId(input), disposition, payload(input), mutation(input, true)));
    if (id === "issue.link")
      return ok9(id, await linkIssue(context, requiredId(input), payload(input), mutation(input, true)));
    throw new Error(`unsupported issue command ${id}`);
  } catch (error) {
    return refused9(id, error);
  }
}
function cliDefinition3(id) {
  const verb = id.slice("issue.".length);
  const optionFlags = {
    id: "--id <id>",
    project: "--project <id>",
    disposition: "--disposition <disposition>",
    kind: "--kind <kind>",
    severity: "--severity <severity>",
    query: "--query <text>",
    limit: "--limit <n>",
    offset: "--offset <n>",
    harness: "--harness <path>",
    file: "--file <path>",
    operationId: "--operation-id <id>",
    actor: "--actor <role>",
    session: "--session <path>",
    expect: "--expect <n>",
    payload: "--payload <json>"
  };
  const options = Object.keys(inputSchema4.shape).map((key) => ({ key, flags: optionFlags[key], required: false }));
  return {
    id,
    cli: { path: ["issue", verb], aliases: [], arguments: [], options },
    input: inputSchema4,
    output: commandEnvelopeSchema,
    effects: readVerbs[verb] === true ? ["read"] : ["write"],
    description: verb === "close" ? "Close as resolved (acceptance evidence in references plus the acceptance authority in alignmentRef)" : verb === "waive" ? "Close as waived" : verb === "duplicate" ? "Close as duplicate of a canonical issue" : verb === "supersede" ? "Close as superseded by a replacement issue" : `Issue ${verb} operation; engine enforces authority, lifecycle and concurrency guards.`,
    execute: (input, context) => execute4(id, input, context)
  };
}
function getIssueCommandDefinitions() {
  return verbs3.map((verb) => cliDefinition3(`issue.${verb}`));
}

// src/families/catalog.ts
import { readFileSync as readFileSync7, writeFileSync as writeFileSync3 } from "node:fs";
import path9 from "node:path";
import {
  SddScriptError as SddScriptError4,
  abortCatalogExecution,
  catalogExportToInputs,
  discoverCatalog,
  exportCatalog,
  getCatalog,
  importCatalog,
  linkCatalogEntities,
  listCatalog,
  listPendingCatalogRegistrations,
  planCatalogImport,
  reconcileCatalogExecution,
  registerCatalogEntity,
  resolveProcessHarnessDir as resolveProcessHarnessDir10,
  updateCatalogEntity,
  verifyCatalogImport
} from "@mstar-harness/engine";
import { z as z10 } from "zod";
var inputSchema5 = z10.object({
  kind: z10.string().optional(),
  id: z10.string().optional(),
  title: z10.string().optional(),
  description: z10.string().optional(),
  rootKind: z10.string().optional(),
  path: z10.string().optional(),
  documentKind: z10.string().optional(),
  lifecycle: z10.string().optional(),
  sourceHash: z10.string().optional(),
  expect: z10.number().int().nonnegative().optional(),
  fromKind: z10.string().optional(),
  fromId: z10.string().optional(),
  relation: z10.string().optional(),
  toKind: z10.string().optional(),
  toId: z10.string().optional(),
  ordinal: z10.number().int().nonnegative().nullable().optional(),
  project: z10.string().optional(),
  iteration: z10.string().optional(),
  limit: z10.number().int().positive().max(200).optional(),
  offset: z10.number().int().nonnegative().optional(),
  out: z10.string().optional(),
  plan: z10.string().optional(),
  inputs: z10.string().optional(),
  dryRun: z10.boolean().optional(),
  operationId: z10.string().optional(),
  actor: z10.string().optional(),
  harness: z10.string().optional(),
  abort: z10.boolean().optional(),
  list: z10.boolean().optional()
});
var verbs4 = ["discover", "import", "register", "update", "link", "list", "show", "export", "reconcile"];
var entityKinds = ["project", "iteration", "plan", "document"];
var rootKinds = ["repository", "harness", "plans", "iterations", "specs", "knowledge", "projects"];
var documentKinds = ["spec", "knowledge", "guide", "compass", "plan", "roadmap", "review", "other"];
var lifecycles = ["active", "archived", "superseded"];
var relations = ["belongs-to", "documents", "spec-ref", "knowledge-ref", "derived-from", "supersedes"];
var descriptions = {
  discover: "Read-only inventory proposals with source hashes, unknowns and index sections proposed for retirement.",
  import: "Apply a reviewed catalog plan; conflicts and reviewed-source drift refuse the whole import before writes.",
  register: "Register a catalog row or attach to the row owning its canonical location.",
  update: "Change catalog-only metadata with an expected-revision guard.",
  link: "Record a relation between registered catalog rows.",
  list: "List catalog rows with incident relations.",
  show: "Show one catalog row and its incident relations.",
  export: "Export the versioned catalog transport payload.",
  reconcile: "Recover a pending catalog execution registration; --list is read-only and --abort abandons only unwritten work."
};
var cliFlags = {
  kind: "--kind <kind>",
  id: "--id <id>",
  title: "--title <title>",
  description: "--description <text>",
  rootKind: "--root-kind <rootKind>",
  path: "--path <relativePath>",
  documentKind: "--document-kind <kind>",
  lifecycle: "--lifecycle <lifecycle>",
  sourceHash: "--source-hash <sha256>",
  expect: "--expect <n>",
  fromKind: "--from-kind <kind>",
  fromId: "--from-id <id>",
  relation: "--relation <relation>",
  toKind: "--to-kind <kind>",
  toId: "--to-id <id>",
  ordinal: "--ordinal <n>",
  project: "--project <id>",
  iteration: "--iteration <id>",
  limit: "--limit <n>",
  offset: "--offset <n>",
  out: "--out <file>",
  plan: "--plan <file>",
  inputs: "--inputs <file>",
  dryRun: "--dry-run",
  operationId: "--operation-id <id>",
  actor: "--actor <role>",
  harness: "--harness <path>",
  abort: "--abort",
  list: "--list"
};
function envelope(id, data) {
  return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data };
}
function failure2(id, error) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof SddScriptError4)
    return { version: 1, command: id, status: "usage", code: "usage", exitCode: 2, message, details: { operation: id } };
  let code = `${id}.internal-error`;
  if (error !== null && typeof error === "object" && "code" in error && typeof error.code === "string")
    code = error.code;
  return { version: 1, command: id, status: "refused", code, exitCode: 1, message, details: { operation: id } };
}
function storeContext2(input, invocation) {
  const root = resolveProcessHarnessDir10(invocation.cwd, input.harness);
  return { harnessDir: root ?? input.harness ?? invocation.controlRoot ?? invocation.cwd };
}
function requireValue(value, field) {
  if (value === undefined || value.trim() === "")
    throw new SddScriptError4(`${field} is required`, 2);
  return value.trim();
}
function oneOf(value, values, field) {
  const selected = requireValue(value, field);
  if (!values.includes(selected))
    throw new SddScriptError4(`${field} must be one of ${values.join(" | ")}`, 2);
  return selected;
}
async function reviewedPlan(input, context) {
  if (input.plan !== undefined && input.inputs !== undefined)
    throw new SddScriptError4("plan and inputs are mutually exclusive", 2);
  const planFile = input.plan;
  const inputsFile = input.inputs;
  if (planFile === undefined && inputsFile === undefined)
    throw new SddScriptError4("one of plan or inputs is required", 2);
  const file = planFile ?? inputsFile;
  if (!path9.isAbsolute(file))
    throw new SddScriptError4("plan and inputs paths must be absolute", 2);
  let payload2;
  try {
    payload2 = JSON.parse(readFileSync7(file, "utf8"));
  } catch (error) {
    throw new SddScriptError4(`reviewed catalog file could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`, 2);
  }
  if (planFile !== undefined)
    return payload2;
  const inputs = Array.isArray(payload2) ? payload2 : catalogExportToInputs(payload2);
  return await planCatalogImport(context, inputs);
}
function importSummary(plan) {
  return {
    version: plan.version,
    entities: plan.entities.length,
    links: plan.links.length,
    conflicts: plan.conflicts.length,
    unknowns: plan.unknowns.length,
    retirementSections: plan.retirementSections.length,
    sourceDigests: plan.sourceDigests.length
  };
}
async function execute5(id, input, invocation) {
  try {
    const context = storeContext2(input, invocation);
    const verb = id.slice("catalog.".length);
    if (verb === "discover") {
      const plan = await discoverCatalog(context);
      if (input.out !== undefined) {
        if (!path9.isAbsolute(input.out))
          throw new SddScriptError4("out must be an absolute path", 2);
        writeFileSync3(input.out, `${JSON.stringify(plan, null, 2)}
`);
        return envelope(id, { ...importSummary(plan), out: input.out });
      }
      return envelope(id, plan);
    }
    if (verb === "import") {
      const plan = await reviewedPlan(input, context);
      if (input.dryRun) {
        const verification = await verifyCatalogImport(context, plan);
        return envelope(id, { importable: verification.ok, ...importSummary(plan), drift: verification.drift, conflicts: verification.conflicts });
      }
      return envelope(id, await importCatalog(context, plan, {
        operationId: requireValue(input.operationId, "operationId"),
        actor: requireValue(input.actor, "actor")
      }));
    }
    if (verb === "register") {
      const documentKind = input.documentKind === undefined ? undefined : oneOf(input.documentKind, documentKinds, "documentKind");
      const lifecycle = input.lifecycle === undefined ? undefined : oneOf(input.lifecycle, lifecycles, "lifecycle");
      return envelope(id, await registerCatalogEntity(context, {
        kind: oneOf(input.kind, entityKinds, "kind"),
        id: requireValue(input.id, "id"),
        title: requireValue(input.title, "title"),
        description: input.description ?? null,
        rootKind: oneOf(input.rootKind, rootKinds, "rootKind"),
        relativePath: requireValue(input.path, "path"),
        ...documentKind === undefined ? {} : { documentKind },
        ...lifecycle === undefined ? {} : { lifecycle },
        ...input.sourceHash === undefined ? {} : { sourceHash: input.sourceHash }
      }, { operationId: requireValue(input.operationId, "operationId"), actor: requireValue(input.actor, "actor") }));
    }
    if (verb === "update") {
      const patch = {};
      if (input.title !== undefined)
        patch.title = requireValue(input.title, "title");
      if (input.description !== undefined)
        patch.description = input.description;
      if (input.rootKind !== undefined)
        patch.rootKind = oneOf(input.rootKind, rootKinds, "rootKind");
      if (input.path !== undefined)
        patch.relativePath = requireValue(input.path, "path");
      if (input.documentKind !== undefined)
        patch.documentKind = oneOf(input.documentKind, documentKinds, "documentKind");
      if (input.lifecycle !== undefined)
        patch.lifecycle = oneOf(input.lifecycle, lifecycles, "lifecycle");
      if (input.sourceHash !== undefined)
        patch.sourceHash = requireValue(input.sourceHash, "sourceHash");
      if (Object.keys(patch).length === 0)
        throw new SddScriptError4("at least one catalog field must be updated", 2);
      return envelope(id, await updateCatalogEntity(context, {
        kind: oneOf(input.kind, entityKinds, "kind"),
        id: requireValue(input.id, "id")
      }, patch, input.expect ?? -1, { operationId: requireValue(input.operationId, "operationId"), actor: requireValue(input.actor, "actor") }));
    }
    if (verb === "link")
      return envelope(id, await linkCatalogEntities(context, {
        from: { kind: oneOf(input.fromKind, entityKinds, "fromKind"), id: requireValue(input.fromId, "fromId") },
        relation: oneOf(input.relation, relations, "relation"),
        to: { kind: oneOf(input.toKind, entityKinds, "toKind"), id: requireValue(input.toId, "toId") },
        ordinal: input.ordinal ?? null
      }, { operationId: requireValue(input.operationId, "operationId"), actor: requireValue(input.actor, "actor") }));
    if (verb === "list") {
      const filter = {};
      if (input.kind !== undefined)
        filter.kind = oneOf(input.kind, entityKinds, "kind");
      if (input.documentKind !== undefined)
        filter.documentKind = oneOf(input.documentKind, documentKinds, "documentKind");
      if (input.lifecycle !== undefined)
        filter.lifecycle = oneOf(input.lifecycle, lifecycles, "lifecycle");
      if (input.project !== undefined)
        filter.projectId = input.project;
      if (input.iteration !== undefined)
        filter.iterationId = input.iteration;
      if (input.limit !== undefined)
        filter.limit = input.limit;
      if (input.offset !== undefined)
        filter.offset = input.offset;
      return envelope(id, await listCatalog(context, filter));
    }
    if (verb === "show")
      return envelope(id, await getCatalog(context, {
        kind: oneOf(input.kind, entityKinds, "kind"),
        id: requireValue(input.id, "id")
      }));
    if (verb === "export") {
      const payload2 = await exportCatalog(context);
      if (input.out !== undefined) {
        if (!path9.isAbsolute(input.out))
          throw new SddScriptError4("out must be an absolute path", 2);
        writeFileSync3(input.out, `${JSON.stringify(payload2, null, 2)}
`);
        return envelope(id, { version: payload2.version, storeRevision: payload2.storeRevision, entities: payload2.entities.length, links: payload2.links.length, out: input.out });
      }
      return envelope(id, payload2);
    }
    if (verb === "reconcile") {
      if (input.list) {
        if (input.operationId !== undefined || input.abort)
          throw new SddScriptError4("list mode rejects operationId and abort", 2);
        return envelope(id, { pending: await listPendingCatalogRegistrations(context) });
      }
      const operationId = requireValue(input.operationId, "operationId");
      return envelope(id, input.abort ? await abortCatalogExecution(context, operationId, "abandoned from the command surface") : await reconcileCatalogExecution(context, operationId));
    }
    throw new Error(`unsupported catalog command ${id}`);
  } catch (error) {
    return failure2(id, error);
  }
}
var optionsByVerb = {
  discover: ["out", "harness"],
  import: ["plan", "inputs", "dryRun", "operationId", "actor", "harness"],
  register: ["kind", "id", "title", "description", "rootKind", "path", "documentKind", "lifecycle", "sourceHash", "operationId", "actor", "harness"],
  update: ["expect", "title", "description", "rootKind", "path", "documentKind", "lifecycle", "sourceHash", "operationId", "actor", "harness"],
  link: ["fromKind", "fromId", "relation", "toKind", "toId", "ordinal", "operationId", "actor", "harness"],
  list: ["kind", "documentKind", "lifecycle", "project", "iteration", "limit", "offset", "harness"],
  show: ["harness"],
  export: ["out", "harness"],
  reconcile: ["operationId", "abort", "list", "harness"]
};
var argumentsByVerb = {
  discover: [],
  import: [],
  register: [],
  update: ["kind", "id"],
  link: [],
  list: [],
  show: ["kind", "id"],
  export: [],
  reconcile: []
};
var requiredOptions = {
  discover: [],
  import: [],
  register: ["kind", "id", "title", "rootKind", "path"],
  update: ["expect"],
  link: ["fromKind", "fromId", "relation", "toKind", "toId"],
  list: [],
  show: [],
  export: [],
  reconcile: []
};
function getCatalogCommandDefinitions() {
  return verbs4.map((verb) => {
    const id = `catalog.${verb}`;
    const effects = verb === "discover" || verb === "reconcile" ? ["read", "write"] : ["list", "show", "export"].includes(verb) ? ["read"] : ["write"];
    const inputKeys = [...argumentsByVerb[verb], ...optionsByVerb[verb]];
    const input = inputSchema5.pick(Object.fromEntries(inputKeys.map((key) => [key, true])));
    return {
      id,
      cli: {
        path: ["catalog", verb],
        aliases: [],
        arguments: argumentsByVerb[verb].map((key) => ({ key, required: true, variadic: false })),
        options: optionsByVerb[verb].map((key) => ({ key, flags: cliFlags[key], required: requiredOptions[verb].includes(key) }))
      },
      input,
      output: commandEnvelopeSchema,
      effects,
      description: descriptions[verb],
      execute: (value, context) => execute5(id, value, context)
    };
  });
}

// src/families/roadmap.ts
import { readFileSync as readFileSync8 } from "node:fs";
import path10 from "node:path";
import {
  RoadmapError,
  importRoadmapAuthority,
  parseRoadmapContent,
  readRoadmapAuthority,
  replaceRoadmapAuthority,
  resolveProcessHarnessDir as resolveProcessHarnessDir11,
  reviewRoadmapImport
} from "@mstar-harness/engine";
import { z as z11 } from "zod";
var inputSchema6 = z11.object({
  project: z11.string().optional(),
  file: z11.string().optional(),
  review: z11.string().optional(),
  apply: z11.boolean().optional(),
  operation: z11.string().optional(),
  expectProject: z11.number().int().nonnegative().optional(),
  expectRoadmap: z11.union([z11.number().int().positive(), z11.literal("absent")]).optional(),
  format: z11.enum(["markdown", "json"]).optional(),
  harness: z11.string().optional()
});
var verbs5 = ["import", "replace", "show", "export"];
var descriptions2 = {
  import: "Preview a roadmap import read-only or apply a saved reviewed source using engine drift checks.",
  replace: "Replace the complete roadmap using observed project and roadmap revisions.",
  show: "Show the project/catalog revisions, roadmap record and parsed content.",
  export: "Export the stored roadmap as Markdown or versioned JSON transport."
};
var cliFlags2 = {
  project: "--project <id>",
  file: "--file <absolute-md>",
  review: "--review <absolute-json>",
  apply: "--apply",
  operation: "--operation <id>",
  expectProject: "--expect-project <n>",
  expectRoadmap: "--expect-roadmap <n|absent>",
  format: "--format <markdown|json>",
  harness: "--harness <root>"
};

class UsageError extends Error {
}
function usage6(value, flag) {
  if (value === undefined || value.trim() === "")
    throw new UsageError(`${flag} is required`);
  return value.trim();
}
function absolute3(value, flag) {
  if (!path10.isAbsolute(value))
    throw new UsageError(`${flag} must be an absolute path`);
  return value;
}
function storeContext3(input, invocation) {
  const resolved = resolveProcessHarnessDir11(invocation.cwd, input.harness);
  return { harnessDir: resolved ?? input.harness ?? invocation.controlRoot ?? invocation.cwd };
}
function reviewInput(value) {
  const candidate = typeof value === "object" && value !== null && "data" in value ? value.data : value;
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate))
    throw new UsageError("review must contain a RoadmapImportReview object");
  const review = candidate;
  if (review.version !== 1 || typeof review.projectId !== "string" || !Number.isSafeInteger(review.expectedProjectRevision) || review.expectedRoadmapRevision !== "absent" && (!Number.isSafeInteger(review.expectedRoadmapRevision) || review.expectedRoadmapRevision < 1) || typeof review.sourcePath !== "string" || !path10.isAbsolute(review.sourcePath) || typeof review.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(review.sourceHash))
    throw new UsageError("review has invalid RoadmapImportReview fields");
  return review;
}
function readReviewFile(value) {
  const file = absolute3(value, "--review");
  try {
    return JSON.parse(readFileSync8(file, "utf8"));
  } catch (error) {
    throw new UsageError(`--review could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function success(id, data) {
  return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data };
}
function failure3(id, error) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof UsageError)
    return { version: 1, command: id, status: "usage", code: "usage", exitCode: 2, message, details: { operation: id } };
  let code = `${id}.internal-error`;
  if (error !== null && typeof error === "object" && "code" in error && typeof error.code === "string")
    code = error.code;
  return { version: 1, command: id, status: "refused", code, exitCode: 1, message, details: { operation: id } };
}
async function execute6(id, input, invocation) {
  try {
    const context = storeContext3(input, invocation);
    const verb = id.slice("roadmap.".length);
    if (verb === "show") {
      const read = await readRoadmapAuthority(context, usage6(input.project, "--project"));
      const content = read.roadmap === null ? null : parseRoadmapContent(read.roadmap.contentMarkdown);
      return success(id, { projectId: read.projectId, projectRevision: read.projectRevision, roadmap: read.roadmap, content });
    }
    if (verb === "import") {
      if (input.apply) {
        if (input.project !== undefined || input.file !== undefined || input.review === undefined)
          throw new UsageError("apply mode requires --review and rejects --project/--file");
        return success(id, await importRoadmapAuthority(context, reviewInput(readReviewFile(input.review)), { operationId: usage6(input.operation, "--operation") }));
      }
      if (input.review !== undefined || input.operation !== undefined)
        throw new UsageError("preview mode accepts only --project and --file; use --review --apply --operation to commit");
      return success(id, await reviewRoadmapImport(context, usage6(input.project, "--project"), absolute3(usage6(input.file, "--file"), "--file")));
    }
    if (verb === "replace") {
      const bytes = readFileSync8(absolute3(usage6(input.file, "--file"), "--file"));
      let contentMarkdown;
      try {
        contentMarkdown = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(new Uint8Array(bytes));
      } catch (error) {
        if (error instanceof TypeError)
          throw new RoadmapError("roadmap.invalid-content", "Replacement file is not valid UTF-8.");
        throw error;
      }
      if (input.expectProject === undefined)
        throw new UsageError("--expect-project is required");
      if (input.expectRoadmap === undefined)
        throw new UsageError("--expect-roadmap is required");
      const expectedRoadmapRevision = input.expectRoadmap;
      return success(id, await replaceRoadmapAuthority(context, {
        projectId: usage6(input.project, "--project"),
        expectedProjectRevision: input.expectProject,
        expectedRoadmapRevision,
        contentMarkdown
      }, { operationId: usage6(input.operation, "--operation") }));
    }
    if (verb === "export") {
      if (input.format === undefined)
        throw new UsageError("--format is required");
      const read = await readRoadmapAuthority(context, usage6(input.project, "--project"));
      if (read.roadmap === null)
        throw Object.assign(new Error("roadmap.absent: project has no stored roadmap content"), { code: "roadmap.absent" });
      const data = input.format === "markdown" ? read.roadmap.contentMarkdown : {
        version: 1,
        projectId: read.projectId,
        revision: read.roadmap.revision,
        contentHash: read.roadmap.contentHash,
        contentMarkdown: read.roadmap.contentMarkdown
      };
      return success(id, data);
    }
    throw new Error(`unsupported roadmap command ${id}`);
  } catch (error) {
    return failure3(id, error);
  }
}
var optionsByVerb2 = {
  import: ["project", "file", "review", "apply", "operation", "harness"],
  replace: ["project", "file", "expectProject", "expectRoadmap", "operation", "harness"],
  show: ["project", "harness"],
  export: ["project", "format", "harness"]
};
var requiredOptions2 = {
  import: [],
  replace: ["project", "file", "expectProject", "expectRoadmap", "operation"],
  show: ["project"],
  export: ["project", "format"]
};
function getRoadmapCommandDefinitions() {
  return verbs5.map((verb) => {
    const id = `roadmap.${verb}`;
    const effects = verb === "import" ? ["read", "write"] : verb === "show" || verb === "export" ? ["read"] : ["write"];
    const input = inputSchema6.pick(Object.fromEntries(optionsByVerb2[verb].map((key) => [key, true])));
    return {
      id,
      cli: {
        path: ["roadmap", verb],
        aliases: [],
        arguments: [],
        options: optionsByVerb2[verb].map((key) => ({ key, flags: cliFlags2[key], required: requiredOptions2[verb].includes(key) }))
      },
      input,
      output: commandEnvelopeSchema,
      effects,
      description: descriptions2[verb],
      execute: (value, context) => execute6(id, value, context)
    };
  });
}

// src/families/sdd.ts
import { readFileSync as readFileSync9 } from "node:fs";
import path11 from "node:path";
import {
  SddScriptError as SddScriptError5,
  checkSddAction,
  resolveSddExecutionContext,
  reviewPackage,
  sddWorkspace,
  taskBrief
} from "@mstar-harness/engine";
import { z as z12 } from "zod";
var verbs6 = ["workspace", "task-brief", "review-package", "check-context", "evidence.capture", "evidence.verify"];
var inputSchemas = {
  workspace: z12.object({ planId: z12.string().optional(), controlRoot: z12.string().optional() }),
  "task-brief": z12.object({ planFile: z12.string().optional(), taskNumber: z12.string().optional(), outfile: z12.string().optional(), context: z12.string().optional() }),
  "review-package": z12.object({ base: z12.string().optional(), head: z12.string().optional(), outfile: z12.string().optional(), context: z12.string().optional() }),
  "check-context": z12.object({ context: z12.string().optional(), kind: z12.enum(["source", "artifact", "launch"]).optional(), target: z12.string().optional() }),
  "evidence.capture": z12.object({ request: z12.string().optional(), argv: z12.array(z12.string()).optional() }),
  "evidence.verify": z12.object({ sddDir: z12.string().optional(), plan: z12.string().optional(), task: z12.string().optional(), run: z12.string().optional(), target: z12.string().optional() })
};
function ok10(id, data) {
  return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data };
}
function failed(id, error) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof SddScriptError5 && error.exitCode === 2) {
    return { version: 1, command: id, status: "usage", code: "usage", exitCode: 2, message };
  }
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : `${id}.refused`;
  return { version: 1, command: id, status: "refused", code, exitCode: error instanceof SddScriptError5 ? error.exitCode : 1, message };
}
function required3(value, flag) {
  if (value === undefined || value.trim() === "")
    throw new SddScriptError5(`${flag} is required`, 2);
  return value;
}
function readContext(value) {
  if (value === undefined)
    return;
  if (!path11.isAbsolute(value))
    throw new SddScriptError5("--context must be an absolute path", 2);
  const doc = JSON.parse(readFileSync9(value, "utf8"));
  if (doc === null || typeof doc !== "object" || Array.isArray(doc))
    throw new SddScriptError5("context file must contain a JSON object", 2);
  return resolveSddExecutionContext(doc);
}
async function execute7(id, input, invocation) {
  try {
    const verb = id.slice("sdd.".length);
    if (verb === "workspace") {
      return ok10(id, { sddDir: sddWorkspace(required3(input.planId, "PLAN_ID"), input.controlRoot ? { controlRoot: input.controlRoot } : {}) });
    }
    if (verb === "task-brief") {
      const planFile = required3(input.planFile, "PLAN_FILE");
      const taskNumber = required3(input.taskNumber, "TASK_NUMBER");
      const bound = readContext(input.context);
      const outfile = taskBrief(planFile, Number(taskNumber), input.outfile, { cwd: invocation.cwd, ...bound ? { context: bound } : {} });
      return ok10(id, { outfile });
    }
    if (verb === "review-package") {
      const base = required3(input.base, "BASE");
      const head = required3(input.head, "HEAD");
      const bound = readContext(input.context);
      return ok10(id, { outfile: reviewPackage(base, head, input.outfile, { cwd: invocation.cwd, ...bound ? { context: bound } : {} }) });
    }
    if (verb === "check-context") {
      const context = readContext(required3(input.context, "--context"));
      const kind = required3(input.kind, "--kind");
      const gate = checkSddAction(context, { kind, cwd: invocation.cwd, target: input.target });
      if (!gate.ok)
        throw new SddScriptError5(gate.violations.map(({ code, message }) => `${code}: ${message}`).join("; "), 1);
      return ok10(id, { kind, planId: context.planId });
    }
    if (verb === "evidence.capture") {
      const request = required3(input.request, "--request");
      const argv = input.argv ?? [];
      if (argv.length === 0)
        throw new SddScriptError5("argv after -- must include the child executable", 2);
      const capture = invocation.effects.captureSddEvidence;
      if (!capture)
        throw new SddScriptError5("SDD evidence capture is unavailable in this invocation context", 1);
      const result = await capture(request, argv);
      if (result.exitCode === 0)
        return ok10(id, result);
      return {
        version: 1,
        command: id,
        status: "error",
        code: "sdd.evidence.child-exit",
        exitCode: result.exitCode,
        message: `child exited with status ${result.exitCode}`,
        details: { runDir: result.runDir, record: result.record }
      };
    }
    if (verb === "evidence.verify") {
      const verify = invocation.effects.verifySddEvidence;
      if (!verify)
        throw new SddScriptError5("SDD evidence verification is unavailable in this invocation context", 1);
      const result = await verify({
        sddDir: required3(input.sddDir, "--sdd-dir"),
        planId: required3(input.plan, "--plan"),
        taskId: required3(input.task, "--task"),
        runId: required3(input.run, "--run"),
        ...input.target !== undefined ? { targetPath: input.target } : {}
      });
      return ok10(id, result);
    }
    throw new SddScriptError5(`unsupported SDD command: ${id}`, 2);
  } catch (error) {
    return failed(id, error);
  }
}
var contract = {
  workspace: { path: ["sdd", "workspace"], arguments: [{ key: "planId", required: false, variadic: false }, { key: "controlRoot", required: false, variadic: false }], options: [], effects: ["read", "write"], description: "Resolve and ensure {SDD_DIR} for a plan." },
  "task-brief": { path: ["sdd", "task-brief"], arguments: [{ key: "planFile", required: false, variadic: false }, { key: "taskNumber", required: false, variadic: false }, { key: "outfile", required: false, variadic: false }], options: [{ key: "context", flags: "--context <path>", required: false }], effects: ["read", "write"], description: "Extract the requested plan task section into its SDD brief; missing tasks preserve exit code 3." },
  "review-package": { path: ["sdd", "review-package"], arguments: [{ key: "base", required: false, variadic: false }, { key: "head", required: false, variadic: false }, { key: "outfile", required: false, variadic: false }], options: [{ key: "context", flags: "--context <path>", required: false }], effects: ["read", "write", "process"], description: "Write commits, stat and diff -U10 for BASE..HEAD into a review package." },
  "check-context": { path: ["sdd", "check-context"], arguments: [], options: [{ key: "context", flags: "--context <path>", required: false }, { key: "kind", flags: "--kind <kind>", required: false }, { key: "target", flags: "--target <path>", required: false }], effects: ["read", "validate"], description: "Gate one action seam against a resolved SDD execution context." },
  "evidence.capture": { path: ["sdd", "evidence", "capture"], arguments: [{ key: "argv", required: false, variadic: true }], options: [{ key: "request", flags: "--request <path>", required: false }], effects: ["read", "write", "process"], description: "Capture evidence for an already-authorized literal argv child." },
  "evidence.verify": { path: ["sdd", "evidence", "verify"], arguments: [], options: [{ key: "sddDir", flags: "--sdd-dir <path>", required: false }, { key: "plan", flags: "--plan <id>", required: false }, { key: "task", flags: "--task <id>", required: false }, { key: "run", flags: "--run <uuid>", required: false }, { key: "target", flags: "--target <path>", required: false }], effects: ["read", "validate"], description: "Read-only integrity and applicability assessment of a retained evidence bundle." }
};
function cliDefinition4(verb) {
  const id = `sdd.${verb}`;
  const shape = contract[verb];
  return { id, cli: { path: shape.path, aliases: [], arguments: shape.arguments, options: shape.options }, input: inputSchemas[verb], output: commandEnvelopeSchema, effects: shape.effects, description: shape.description, execute: (input, invocation) => execute7(id, input, invocation) };
}
function getSddCommandDefinitions() {
  return verbs6.map(cliDefinition4);
}

// src/families/validation.ts
import { existsSync as existsSync5, readFileSync as readFileSync10, readdirSync as readdirSync2, statSync } from "node:fs";
import path12 from "node:path";
import {
  assertDefaultBranchProtected,
  assertIndexRows,
  assertLightDarkParity,
  assertQcAlignment,
  assertSddTddTriple,
  assertTriIdentity,
  classifySkillLint,
  completenessLevel,
  executionModeToN,
  findEphemeralCitations,
  findProvenanceCitations,
  findSimplifyMarkers,
  findTemporaryMarkers,
  isReadOnlyAssignmentRole,
  l1PreDispatchCheck,
  l2PreDispatchCheck,
  lintFiveQuestion,
  lintFrontmatter,
  lintLoadOrder,
  lintStrategySections,
  parseAssignmentBranchForms,
  parseAssignmentFields,
  parseBranchPolicyDirectOnBranch,
  planQualityBar,
  scanActiveLifecycleBranches,
  scopeGuard,
  SddScriptError as SddScriptError6,
  stripFrontmatter,
  validateAssignmentFields,
  validateDesignTokenFrontmatter,
  validateFindingDoc,
  validateQcReport,
  validateRoleMapping,
  validateSchemaYaml,
  WorkflowSnapshotValidationError,
  readWorkflowSnapshot as readWorkflowSnapshot2,
  resolveProcessHarnessDir as resolveProcessHarnessDir12
} from "@mstar-harness/engine";
import { z as z13 } from "zod";
function assignmentExecutionMode(text) {
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\*\*\s*Execution mode\s*\*\*\s*:\s*(.*)$/) ?? line.match(/^Execution mode\s*:\s*(.*)$/);
    if (match)
      return match[1].trim();
  }
  return "";
}
var verbs7 = ["dispatch.validate", "worktree.check", "worktree.qc-alignment", "review.seats", "lint", "design-md.validate", "compound.validate", "skill.lint", "roles.validate", "qc.validate-report"];
var schemas = {
  "dispatch.validate": z13.object({ assignmentFile: z13.string().optional(), branch: z13.string().optional() }),
  "worktree.check": z13.object({ planId: z13.string().optional(), plan: z13.string().optional(), workflow: z13.string().optional(), harness: z13.string().optional(), integration: z13.string().optional(), mainBranch: z13.string().optional(), control: z13.string().optional(), l2: z13.boolean().optional(), tracks: z13.string().optional() }),
  "worktree.qc-alignment": z13.object({ files: z13.array(z13.string()).optional() }),
  "review.seats": z13.object({ assignmentFile: z13.string().optional(), mode: z13.string().optional(), reviewers: z13.array(z13.string()).optional() }),
  lint: z13.object({ target: z13.string().optional(), type: z13.string().optional(), prVariant: z13.boolean().optional() }),
  "design-md.validate": z13.object({ dir: z13.string().optional() }),
  "compound.validate": z13.object({ docPath: z13.string().optional(), knowledgeDir: z13.string().optional() }),
  "skill.lint": z13.object({ skillDir: z13.string().optional() }),
  "roles.validate": z13.object({ rolesDir: z13.string().optional(), skillsDir: z13.string().optional() }),
  "qc.validate-report": z13.object({ reportFile: z13.string().optional() })
};
function ok11(id, data) {
  return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data };
}
function refusal(id, code, message, details) {
  return { version: 1, command: id, status: "refused", code, exitCode: 1, message, ...details === undefined ? {} : { details } };
}
function failed2(id, error) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof SddScriptError6 && error.exitCode === 2)
    return { version: 1, command: id, status: "usage", code: "usage", exitCode: 2, message };
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : `${id}.refused`;
  return { version: 1, command: id, status: "refused", code, exitCode: 1, message };
}
function required4(value, message) {
  if (value === undefined || value.trim() === "")
    throw new SddScriptError6(message, 2);
  return value;
}
function rejected(id, result, fallback) {
  const first = result.violations[0];
  return refusal(id, first?.code ?? fallback, first?.message ?? fallback, { violations: result.violations });
}
function gateData(result) {
  return { ok: result.ok, violations: result.violations };
}
function absolute4(cwd, input) {
  return path12.isAbsolute(input) ? input : path12.resolve(cwd, input);
}
var codeExtensions = Object.fromEntries([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".sh", ".bash", ".zsh", ".rb", ".java", ".kt", ".swift"].map((ext) => [ext, true]));
var provenanceExtensions = { ".md": true, ".ts": true };
var skipDirs = { node_modules: true, ".git": true, dist: true, coverage: true, ".turbo": true };
function lintType(file) {
  const base = path12.basename(file);
  if (base === "STRATEGY.md")
    return "strategy";
  if (base === "SKILL.md")
    return "skill";
  if (/^task-\d+-report\.md$/i.test(base))
    return "report";
  const dir = path12.dirname(file);
  if (dir.includes(`${path12.sep}plans${path12.sep}`) || dir.endsWith(`${path12.sep}plans`) || /^\d{8}-[a-z0-9.-]+\.md$/i.test(base))
    return "plan";
  return codeExtensions[path12.extname(base).toLowerCase()] ? "code" : null;
}
function collectTargets(dir, accept = (file) => lintType(file) !== null) {
  const targets = [];
  const visit = (current) => {
    for (const entry of readdirSync2(current, { withFileTypes: true })) {
      if (entry.name.includes(path12.sep))
        continue;
      const child = current + entry.name;
      if (entry.isDirectory()) {
        if (!skipDirs[entry.name])
          visit(child + path12.sep);
      } else if (entry.isFile() && accept(child))
        targets.push(child);
    }
  };
  visit(dir.endsWith(path12.sep) ? dir : `${dir}${path12.sep}`);
  return targets;
}
function parseHeaderField(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bold = new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?\\*\\*\\s*${escaped}\\s*\\*\\*\\s*:\\s*(.*)$`);
  const plain = new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?${escaped}\\s*:\\s*(.*)$`);
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(bold) ?? line.match(plain);
    if (match)
      return match[1].trim();
  }
  return "";
}
function lintOne(file, type, prVariant = false) {
  const text = readFileSync10(file, "utf8");
  const violations = [];
  const markers = [];
  switch (type ?? lintType(file)) {
    case "plan":
      violations.push(...planQualityBar(text).violations);
      break;
    case "skill":
      violations.push(...lintFrontmatter(text).violations);
      break;
    case "strategy":
      violations.push(...lintStrategySections(text).violations);
      break;
    case "report":
      violations.push(...assertSddTddTriple(text).violations);
      break;
    case "code": {
      for (const marker of findSimplifyMarkers(text))
        markers.push(`simplify marker @${marker.line}: ${marker.text}`);
      const temporary = findTemporaryMarkers(text);
      for (const marker of temporary.markers)
        markers.push(`temporary marker @${marker.line}: ${marker.text} (${marker.removalPath === null ? "no removal path" : `removal: ${marker.removalPath}`})`);
      violations.push(...temporary.violations);
      break;
    }
    case "finding":
      violations.push(...validateFindingDoc(text, prVariant ? { prVariant: true } : {}).violations);
      break;
    case "provenance":
      for (const citation of findProvenanceCitations(text))
        violations.push({ ok: false, severity: "medium", code: `lint.provenance.${citation.kind}`, message: `provenance ${citation.kind} citation at line ${citation.line}: "${citation.match}" — tracked content must not disclose local plan/iteration ids or dated harness deep paths`, fix: `rewrite "${citation.match}" as a placeholder form (e.g. task-N-report, <plan-id>) or a synthetic example slug (any -example- segment)` });
      break;
    default:
      throw new SddScriptError6(`usage: lint <target> — unsupported file type "${path12.basename(file)}" (lintable: plan files, SKILL.md, STRATEGY.md, task-N-report.md, code files)`, 2);
  }
  return { violations, markers };
}
async function execute8(id, input, context) {
  try {
    switch (id) {
      case "dispatch.validate": {
        const file = required4(input.assignmentFile, "usage: dispatch validate <assignment-file> [--branch <branch>]");
        if (!existsSync5(file))
          throw new Error(`assignment file not found: ${file}`);
        const text = readFileSync10(file, "utf8");
        const readOnly = isReadOnlyAssignmentRole(parseAssignmentFields(text).executeAs ?? "");
        const violations = [...validateAssignmentFields(text, { writable: readOnly ? false : undefined }).violations];
        if (!readOnly) {
          const forms = parseAssignmentBranchForms(text);
          const branch = forms.createForm?.name ?? forms.workingBranch ?? forms.directOn?.branch ?? input.branch ?? process.env.MSTAR_WORKING_BRANCH;
          if (branch?.trim())
            violations.push(...assertDefaultBranchProtected(branch, { directOnException: parseBranchPolicyDirectOnBranch(text) === branch.trim() }).violations);
        }
        const gate = { ok: violations.length === 0, violations };
        return gate.ok ? ok11(id, gateData(gate)) : rejected(id, gate, "dispatch.assignment.invalid");
      }
      case "worktree.check": {
        if (input.l2) {
          const raw = required4(input.tracks, "usage: worktree check --l2 --tracks <json>");
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch {
            throw new SddScriptError6("usage: worktree check --l2 --tracks <json> — invalid JSON", 2);
          }
          if (!Array.isArray(parsed))
            throw new SddScriptError6("usage: worktree check --l2 --tracks <json> — expected a JSON array of {worktreePath, workingBranch}", 2);
          const tracks = [];
          for (const item of parsed) {
            if (item === null || typeof item !== "object" || !("worktreePath" in item) || typeof item.worktreePath !== "string" || !("workingBranch" in item) || typeof item.workingBranch !== "string") {
              throw new SddScriptError6("usage: worktree check --l2 --tracks <json> — every track needs string worktreePath + workingBranch", 2);
            }
            tracks.push({ worktreePath: item.worktreePath, workingBranch: item.workingBranch });
          }
          const gate2 = l2PreDispatchCheck({ tracks });
          return gate2.ok ? ok11(id, gateData(gate2)) : rejected(id, gate2, "worktree.l2.invalid");
        }
        const plan = input.plan ?? input.planId;
        if (!plan)
          throw new SddScriptError6("usage: worktree check <plan-id> --workflow <id> [--harness <path>] [--integration <path>] [--main-branch <branch>] (or --plan <plan-id>)", 2);
        const workflow = required4(input.workflow, "usage: worktree check <plan-id> --workflow <id> [--harness <path>] [--integration <path>] [--main-branch <branch>] (or --plan <plan-id>)");
        if (input.control !== undefined && input.integration !== undefined)
          throw new SddScriptError6("usage: worktree check <plan-id> --workflow <id> — pass --integration or the deprecated --control alias, not both", 2);
        if (workflow === "." || workflow === ".." || workflow.includes("/") || workflow.includes("\\"))
          throw new Error(`invalid workflow id ${JSON.stringify(workflow)}`);
        const harness = resolveProcessHarnessDir12(context.cwd, input.harness) ?? context.controlRoot;
        if (!harness)
          throw new Error("harness directory not found");
        const snapshotPath2 = path12.join(harness, "workflows", workflow, "snapshot.json");
        if (!existsSync5(snapshotPath2))
          throw new Error(`workflow snapshot not found: ${snapshotPath2}`);
        let snapshot;
        try {
          snapshot = readWorkflowSnapshot2(path12.dirname(snapshotPath2)).snapshot;
        } catch (error) {
          if (!(error instanceof WorkflowSnapshotValidationError))
            throw error;
          const first = error.violations[0];
          return refusal(id, first?.code ?? "workflow.snapshot.invalid", first?.message ?? "invalid workflow snapshot", { violations: error.violations });
        }
        const rows = Array.isArray(snapshot.plans) ? snapshot.plans.filter((row) => row?.id === plan || row?.plan_id === plan) : [];
        if (!rows.length)
          return refusal(id, "worktree.l1.plan-not-found", `no plan row with id/plan_id ${plan}`, { snapshotPath: snapshotPath2, planId: plan });
        if (rows.length > 1)
          return refusal(id, "worktree.l1.ambiguous", "multiple plan rows match (id and plan_id both present)", { snapshotPath: snapshotPath2, planId: plan });
        const main = await awaitSpawn(context, ["git", "worktree", "list", "--porcelain"]);
        if (!main.ok)
          return refusal(id, "worktree.probe.unavailable", main.stderr || "main worktree probe failed");
        const primary = main.stdout.split(/\r?\n/).find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
        if (!primary)
          return refusal(id, "worktree.probe.unavailable", "main worktree probe returned no worktree");
        const mainBranch = await awaitSpawn(context, ["git", "branch", "--show-current"], primary);
        if (!mainBranch.ok)
          return refusal(id, "worktree.probe.unavailable", mainBranch.stderr || "branch probe failed");
        const lease = rows[0].execution_lease ?? {};
        const lifecycleBranches = new Set;
        const siblingScan = scanActiveLifecycleBranches(harness, workflow);
        if (siblingScan.kind === "refusal")
          return refusal(id, siblingScan.code, siblingScan.detail);
        for (const other of siblingScan.branches)
          lifecycleBranches.add(other);
        const gate = l1PreDispatchCheck({
          workflowType: snapshot.type,
          integrationWorktreePath: path12.resolve(input.integration ?? input.control ?? snapshot.integration_worktree_path ?? ""),
          integrationBranch: String(snapshot.branch?.integration ?? ""),
          mainWorktree: { root: primary, branch: mainBranch.stdout.trim() },
          expectedMainBranch: input.mainBranch ?? String(snapshot.branch?.base ?? ""),
          lifecycleBranches: [...lifecycleBranches],
          leaseWorktreePath: String(lease.worktree_path ?? ""),
          leaseWorkingBranch: String(lease.working_branch ?? ""),
          planId: plan
        });
        return gate.ok ? ok11(id, gateData(gate)) : rejected(id, gate, "worktree.l1.invalid");
      }
      case "worktree.qc-alignment": {
        const files = input.files ?? [];
        if (!files.length)
          throw new SddScriptError6("usage: worktree qc-alignment <assignment-file>...", 2);
        const assignments = files.map((file) => {
          if (!existsSync5(file))
            throw new Error(`assignment file not found: ${file}`);
          const text = readFileSync10(file, "utf8");
          const combined = parseHeaderField(text, "Review range / Diff basis");
          return { planId: parseHeaderField(text, "plan_id"), reviewRange: parseHeaderField(text, "Review range") || combined, diffBasis: parseHeaderField(text, "Diff basis") || combined };
        });
        const fields = [
          { key: "planId", label: "plan_id" },
          { key: "reviewRange", label: "Review range" },
          { key: "diffBasis", label: "Diff basis" }
        ];
        for (const assignment of assignments) {
          const missing = fields.filter(({ key }) => assignment[key] === "");
          if (missing.length)
            return refusal(id, "qc.alignment.field.missing", `missing "${missing[0].label}" header field`, { fields: missing.map(({ label }) => label), assignments });
        }
        const gate = assertQcAlignment(assignments);
        return gate.ok ? ok11(id, { assignments, ...gateData(gate) }) : rejected(id, gate, "qc.alignment.mismatch");
      }
      case "review.seats": {
        const file = required4(input.assignmentFile, "usage: review seats <assignment-file> [--mode sdd|inline|targeted] [--reviewers <role1,role2,...>]");
        if (!existsSync5(file))
          throw new Error(`assignment file not found: ${file}`);
        const text = readFileSync10(file, "utf8");
        const mode = input.mode ?? assignmentExecutionMode(text);
        const reviewers = input.reviewers ?? [];
        const result = executionModeToN(mode, { seats: reviewers });
        if (!result.ok)
          return rejected(id, result, "review.seats.invalid");
        if ((mode.trim().toLowerCase().split(/\s+/)[0] ?? "") === "sdd" && reviewers.length) {
          const tri = assertTriIdentity(reviewers);
          if (!tri.ok)
            return rejected(id, tri, "review.seats.tri-identity");
        }
        return ok11(id, { n: result.n, mode, reviewers });
      }
      case "lint": {
        const target = required4(input.target, "usage: lint <target> (file or dir)");
        const forced = input.type?.trim().toLowerCase();
        const known = ["plan", "skill", "strategy", "report", "code", "finding", "provenance"];
        if (forced !== undefined && !known.includes(forced))
          throw new SddScriptError6(`usage: lint --type must be one of ${known.join(" | ")}, got ${JSON.stringify(input.type)}`, 2);
        const abs = absolute4(context.cwd, target);
        if (!existsSync5(abs))
          throw new Error(`lint target not found: ${abs}`);
        const isDir = statSync(abs).isDirectory();
        const targets = !isDir ? [abs] : forced === "provenance" ? collectTargets(abs, (file) => provenanceExtensions[path12.extname(file).toLowerCase()] === true) : collectTargets(abs);
        const results = targets.map((file) => ({ file, ...lintOne(file, forced, input.prVariant === true) }));
        return results.some((result) => result.violations.length) ? refusal(id, results.flatMap((r) => r.violations)[0]?.code ?? "lint.violations", "lint violations found", { results }) : ok11(id, { results });
      }
      case "design-md.validate": {
        const dir = absolute4(context.cwd, required4(input.dir, "usage: design-md validate <dir>"));
        const lightPath = path12.join(dir, "DESIGN.md");
        if (!existsSync5(lightPath))
          throw new Error(`design file not found: ${lightPath}`);
        const light = readFileSync10(lightPath, "utf8");
        const violations = [...validateDesignTokenFrontmatter(light).violations];
        const darkPath = path12.join(dir, "DESIGN.dark.md");
        if (existsSync5(darkPath))
          violations.push(...assertLightDarkParity(light, readFileSync10(darkPath, "utf8")).violations);
        const level = completenessLevel(light);
        const gate = { ok: violations.length === 0, violations };
        return gate.ok ? ok11(id, { ...gateData(gate), completeness: level }) : rejected(id, gate, "design-md.invalid");
      }
      case "compound.validate": {
        const docPath = absolute4(context.cwd, required4(input.docPath, "usage: compound validate <doc-path> [--knowledge-dir <dir>]"));
        if (!existsSync5(docPath))
          throw new Error(`knowledge doc not found: ${docPath}`);
        const violations = [...validateSchemaYaml(readFileSync10(docPath, "utf8")).violations];
        if (input.knowledgeDir !== undefined) {
          const knowledgeDir = absolute4(context.cwd, input.knowledgeDir);
          violations.push(...assertIndexRows(knowledgeDir).violations, ...scopeGuard(docPath, [knowledgeDir]).violations);
        }
        const gate = { ok: violations.length === 0, violations };
        return gate.ok ? ok11(id, gateData(gate)) : rejected(id, gate, "compound.invalid");
      }
      case "skill.lint": {
        const dir = absolute4(context.cwd, required4(input.skillDir, "usage: skill lint <skill-dir>"));
        const skillFile = path12.join(dir, "SKILL.md");
        if (!existsSync5(skillFile))
          throw new Error(`SKILL.md not found: ${skillFile}`);
        const text = readFileSync10(skillFile, "utf8");
        const violations = [...lintFrontmatter(text).violations];
        const profile = classifySkillLint(path12.basename(dir));
        if (profile.mode !== null)
          violations.push(...lintFiveQuestion(stripFrontmatter(text), profile.mode).violations);
        violations.push(...findEphemeralCitations(text).map((citation) => ({ ok: false, severity: "medium", code: `skill.ephemeral.${citation.kind}`, message: `ephemeral ${citation.kind} citation at line ${citation.line}: "${citation.match}" — task artifacts and SDD deeplinks survive nothing; durable skill text cites in-repo artifacts only (knowledge conventions §3)`, fix: `rewrite "${citation.match}" as a placeholder form (e.g. task-N-report, <plan-id>, {SDD_DIR}/task-N-report.md) or cite a stable in-repo artifact instead` })));
        const gate = { ok: violations.length === 0, violations };
        return gate.ok ? ok11(id, { ...gateData(gate), exempt: profile.mode === null }) : rejected(id, gate, "skill.lint.invalid");
      }
      case "roles.validate": {
        const rolesDir = absolute4(context.cwd, input.rolesDir ?? "skills/mstar-roles");
        const skillsRoot = absolute4(context.cwd, input.skillsDir ?? path12.dirname(rolesDir));
        const violations = [...validateRoleMapping(rolesDir).violations];
        const skillTexts = {};
        for (const entry of readdirSync2(skillsRoot, { withFileTypes: true })) {
          if (!entry.isDirectory() || !entry.name.startsWith("mstar-"))
            continue;
          const file = path12.join(skillsRoot, entry.name, "SKILL.md");
          if (!existsSync5(file))
            continue;
          try {
            skillTexts[entry.name] = readFileSync10(file, "utf8");
          } catch {}
        }
        const loadOrder = lintLoadOrder(skillTexts);
        violations.push(...loadOrder.violations);
        const gate = { ok: violations.length === 0, violations };
        return gate.ok ? ok11(id, { ...gateData(gate), siblingCount: Object.keys(skillTexts).length, loadOrderChecked: Object.keys(skillTexts).filter((name) => name !== "mstar-harness-core").length }) : rejected(id, gate, "roles.invalid");
      }
      case "qc.validate-report": {
        const file = absolute4(context.cwd, required4(input.reportFile, "report file is required"));
        if (!existsSync5(file))
          throw new Error(`report file not found: ${file}`);
        const gate = validateQcReport(readFileSync10(file, "utf8"));
        return gate.ok ? ok11(id, gateData(gate)) : rejected(id, gate, "qc.report.invalid");
      }
      default:
        return failed2(id, new Error(`unsupported validation command: ${id}`));
    }
  } catch (error) {
    return failed2(id, error);
  }
}
async function awaitSpawn(context, argv, cwd = context.cwd) {
  const result = await context.effects.spawn({ argv, cwd, env: {}, signal: context.signal });
  return { ok: result.exitCode === 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}
var contract2 = {
  "dispatch.validate": { path: ["dispatch", "validate"], args: [{ key: "assignmentFile", required: true, variadic: false }], options: [{ key: "branch", flags: "--branch <branch>" }], effects: ["read", "validate"], description: "Validate Assignment fields and branch protection." },
  "worktree.check": { path: ["worktree", "check"], args: [{ key: "planId", required: false, variadic: false }], options: [{ key: "plan", flags: "--plan <plan-id>" }, { key: "workflow", flags: "--workflow <id>" }, { key: "harness", flags: "--harness <path>" }, { key: "integration", flags: "--integration <path>" }, { key: "mainBranch", flags: "--main-branch <branch>" }, { key: "control", flags: "--control <path>" }, { key: "l2", flags: "--l2" }, { key: "tracks", flags: "--tracks <json>" }], effects: ["read", "validate", "process"], description: "Run the existing L1/L2 worktree pre-dispatch gate." },
  "worktree.qc-alignment": { path: ["worktree", "qc-alignment"], args: [{ key: "files", required: true, variadic: true }], options: [], effects: ["read", "validate"], description: "Assert QC/QA Assignment alignment." },
  "review.seats": { path: ["review", "seats"], args: [{ key: "assignmentFile", required: true, variadic: false }], options: [{ key: "mode", flags: "--mode <mode>" }, { key: "reviewers", flags: "--reviewers <list>" }], effects: ["read", "validate"], description: "Map execution mode to QC seat count and assert tri identity." },
  lint: { path: ["lint"], args: [{ key: "target", required: true, variadic: false }], options: [{ key: "type", flags: "--type <type>" }, { key: "prVariant", flags: "--pr-variant" }], effects: ["read", "validate"], description: "Lint harness artifacts by content type." },
  "design-md.validate": { path: ["design-md", "validate"], args: [{ key: "dir", required: true, variadic: false }], options: [], effects: ["read", "validate"], description: "Validate DESIGN.md token frontmatter, parity and completeness." },
  "compound.validate": { path: ["compound", "validate"], args: [{ key: "docPath", required: true, variadic: false }], options: [{ key: "knowledgeDir", flags: "--knowledge-dir <dir>" }], effects: ["read", "validate"], description: "Validate a knowledge document and optional index scope." },
  "skill.lint": { path: ["skill", "lint"], args: [{ key: "skillDir", required: true, variadic: false }], options: [], effects: ["read", "validate"], description: "Lint a skill directory." },
  "roles.validate": { path: ["roles", "validate"], args: [], options: [{ key: "rolesDir", flags: "--roles-dir <dir>" }, { key: "skillsDir", flags: "--skills-dir <dir>" }], effects: ["read", "validate"], description: "Validate the role mapping and load-order corpus." },
  "qc.validate-report": { path: ["qc", "validate-report"], args: [{ key: "reportFile", required: true, variadic: false }], options: [], effects: ["read", "validate"], description: "Validate a saved QC seat report." }
};
function definition(verb) {
  const id = verb;
  const item = contract2[verb];
  return { id, cli: { path: item.path, aliases: [], arguments: item.args, options: item.options.map((option) => ({ ...option, required: false })) }, input: schemas[verb], output: commandEnvelopeSchema, effects: item.effects, description: item.description, execute: (input, context) => execute8(id, input, context) };
}
function getValidationCommandDefinitions() {
  return verbs7.map(definition);
}

// src/families/audit.ts
import { execFileSync } from "node:child_process";
import { existsSync as existsSync6, readFileSync as readFileSync11, statSync as statSync2 } from "node:fs";
import path13 from "node:path";
import {
  AUDIT_CATEGORIES,
  AUDIT_CONFIDENCES,
  AUDIT_EFFORTS,
  AUDIT_PRIORITIES,
  AUDIT_RISKS,
  SddScriptError as SddScriptError7,
  createFsStore as createFsStore7,
  registerShippedCatalogExecution as registerShippedCatalogExecution2,
  resolveProcessHarnessDir as resolveProcessHarnessDir13,
  scanSecrets,
  scaffoldAuditPlan,
  setArtifactStore as setArtifactStore7,
  supplyChainChecks,
  WORKFLOW_DELIVERY_KINDS as WORKFLOW_DELIVERY_KINDS3
} from "@mstar-harness/engine";
import { randomUUID as randomUUID2 } from "node:crypto";
import { z as z14 } from "zod";
var verbs8 = ["scaffold", "promote", "secret-scan", "supply-chain"];
var inputSchema7 = z14.object({
  findings: z14.string().optional(),
  dir: z14.string().optional(),
  sha: z14.string().optional(),
  date: z14.string().optional(),
  repo: z14.string().optional(),
  plans: z14.string().optional(),
  workflow: z14.string().optional(),
  deliveryKind: z14.string().optional(),
  branchSource: z14.string().optional(),
  branchTarget: z14.string().optional(),
  completionPolicy: z14.string().optional(),
  harness: z14.string().optional(),
  path: z14.string().optional()
});
var contracts = {
  scaffold: { args: [{ key: "findings", required: false, variadic: false }], options: [
    { key: "dir", flags: "--dir <out-dir>", required: false },
    { key: "sha", flags: "--sha <commit>", required: false },
    { key: "date", flags: "--date <YYYY-MM-DD>", required: false },
    { key: "repo", flags: "--repo <name>", required: false }
  ], effects: ["read", "write"], description: "Scaffold audit plan artifacts in the declared output directory." },
  promote: { args: [{ key: "path", required: false, variadic: false }], options: [
    { key: "plans", flags: "--plans <ids>", required: false },
    { key: "workflow", flags: "--workflow <id>", required: false },
    { key: "deliveryKind", flags: "--delivery-kind <kind>", required: false },
    { key: "branchSource", flags: "--branch-source <branch>", required: false },
    { key: "branchTarget", flags: "--branch-target <branch>", required: false },
    { key: "completionPolicy", flags: "--completion-policy <text>", required: false },
    { key: "harness", flags: "--harness <dir>", required: false }
  ], effects: ["read", "write"], description: "Promote selected audit plans into a declared v2 workflow lifecycle." },
  "secret-scan": { args: [{ key: "path", required: false, variadic: false }], options: [], effects: ["read", "validate", "process"], description: "Scan git-tracked files for credential findings without printing secret values." },
  "supply-chain": { args: [{ key: "path", required: false, variadic: false }], options: [], effects: ["read", "validate"], description: "Run existing read-only supply-chain checks on a repository root." }
};
function idFor(verb) {
  return `audit.${verb}`;
}
function ok12(id, data) {
  return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data };
}
function failure4(id, error) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof SddScriptError7 && error.exitCode === 2)
    return { version: 1, command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message };
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : `${id}.refused`;
  return { version: 1, command: id, status: "refused", code, exitCode: 1, message };
}
function required5(value, label) {
  if (value === undefined || value.trim() === "")
    throw new SddScriptError7(`${label} is required`, 2);
  return value;
}
function resolvePath(cwd, value) {
  return path13.resolve(cwd, value);
}
function parseFindings(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new SddScriptError7("findings file is not valid JSON", 2);
  }
  const doc = Array.isArray(data) ? { findings: data } : data;
  if (doc === null || typeof doc !== "object" || !Array.isArray(doc.findings))
    throw new SddScriptError7("findings file must be an array or an object with a findings array", 2);
  const raw = doc;
  const findings = raw.findings.map((value, index) => {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new SddScriptError7(`findings[${index}] is not an object`, 2);
    const row = value;
    const enumValue = (field, values) => {
      const selected = row[field];
      if (typeof selected !== "string" || !values.includes(selected))
        throw new SddScriptError7(`findings[${index}].${field} must be one of ${values.join("|")}`, 2);
      return selected;
    };
    const title = typeof row.title === "string" ? row.title.trim() : "";
    const impact = typeof row.description === "string" ? row.description.trim() : "";
    if (!title || !impact)
      throw new SddScriptError7(`findings[${index}] needs non-empty title and description`, 2);
    const priority = enumValue("priority", AUDIT_PRIORITIES);
    const effort = enumValue("effort", AUDIT_EFFORTS);
    const risk = enumValue("risk", AUDIT_RISKS);
    const category = enumValue("category", AUDIT_CATEGORIES);
    const confidence = row.confidence === undefined ? "MED" : enumValue("confidence", AUDIT_CONFIDENCES);
    const evidence = row.evidence === undefined ? [] : row.evidence;
    if (!Array.isArray(evidence))
      throw new SddScriptError7(`findings[${index}].evidence must be an array`, 2);
    const normalizedEvidence = evidence.map((entry, itemIndex) => {
      if (typeof entry === "string" && entry.trim() !== "")
        return entry;
      if (entry === null || typeof entry !== "object" || Array.isArray(entry))
        throw new SddScriptError7(`findings[${index}].evidence[${itemIndex}] must be a non-empty string or location object`, 2);
      const location = entry;
      if (typeof location.file !== "string" || location.file === "" || typeof location.description !== "string" || location.description.trim() === "")
        throw new SddScriptError7(`findings[${index}].evidence[${itemIndex}] requires a repository-relative file and non-empty description`, 2);
      if (location.line !== undefined && (typeof location.line !== "number" || !Number.isSafeInteger(location.line) || location.line <= 0))
        throw new SddScriptError7(`findings[${index}].evidence[${itemIndex}].line must be a positive integer`, 2);
      return { file: location.file, ...location.line !== undefined ? { line: location.line } : {}, description: location.description };
    });
    const rawDependency = typeof row.dependsOn === "string" && row.dependsOn.trim() ? row.dependsOn.trim() : undefined;
    if (rawDependency !== undefined && !/^(?:none|plans\/\d{3}-[\w.*-]+\.md|\d{3})$/i.test(rawDependency))
      throw new SddScriptError7(`findings[${index}].dependsOn must be "none", "plans/NNN-*.md", or a plan number NNN`, 2);
    const dependsOn = rawDependency !== undefined && /^\d{3}$/.test(rawDependency) ? `plans/${rawDependency}-*.md` : rawDependency;
    const fingerprint = row.fingerprint;
    if (fingerprint !== undefined && (typeof fingerprint !== "string" || fingerprint === ""))
      throw new SddScriptError7(`findings[${index}].fingerprint must be a non-empty string`, 2);
    const optionalText = (key) => {
      const v = row[key];
      if (v === undefined)
        return;
      if (typeof v !== "string" || v.trim() === "")
        throw new SddScriptError7(`findings[${index}].${key} must be a non-empty string`, 2);
      return v.trim();
    };
    const severity = row.severity;
    if (severity !== undefined) {
      if (severity === null || typeof severity !== "object" || !["likelihood", "impact", "overall"].every((key) => ["informational", "low", "medium", "high", "critical"].includes(severity[key])))
        throw new SddScriptError7(`findings[${index}].severity must contain likelihood, impact and overall ranks`, 2);
    }
    const trace = row.trace;
    if (trace !== undefined && !Array.isArray(trace))
      throw new SddScriptError7(`findings[${index}].trace must be an array`, 2);
    return {
      title,
      impact,
      priority,
      effort,
      risk,
      category,
      confidence,
      evidence: normalizedEvidence,
      ...dependsOn !== undefined ? { dependsOn } : {},
      ...fingerprint !== undefined ? { fingerprint } : {},
      ...severity !== undefined ? { severity } : {},
      ...trace !== undefined ? { trace } : {},
      ...optionalText("fixSketch") !== undefined ? { fixSketch: optionalText("fixSketch") } : {},
      ...optionalText("verification") !== undefined ? { verification: optionalText("verification") } : {}
    };
  });
  const needsVerification = raw.needsVerification;
  if (needsVerification !== undefined && !Array.isArray(needsVerification))
    throw new SddScriptError7("needsVerification must be an array of {lead, how, evidence?}", 2);
  const parsedVerification = needsVerification?.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry))
      throw new SddScriptError7(`needsVerification[${index}] is not an object`, 2);
    const item = entry;
    const lead = typeof item.lead === "string" ? item.lead.trim() : "";
    const how = typeof item.how === "string" ? item.how.trim() : "";
    if (!lead || !how)
      throw new SddScriptError7(`needsVerification[${index}] needs non-empty lead and how`, 2);
    const evidence = typeof item.evidence === "string" && item.evidence.trim() ? item.evidence.trim() : undefined;
    return { lead, how, ...evidence !== undefined ? { evidence } : {} };
  });
  const hardeningChecked = raw.hardeningChecked;
  if (hardeningChecked !== undefined && !Array.isArray(hardeningChecked))
    throw new SddScriptError7("hardeningChecked must be an array of {kind, text}", 2);
  const parsedHardening = hardeningChecked?.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry))
      throw new SddScriptError7(`hardeningChecked[${index}] is not an object`, 2);
    const item = entry;
    const kind = item.kind;
    const text2 = typeof item.text === "string" ? item.text.trim() : "";
    if (kind !== "Hardening" && kind !== "Checked and clean")
      throw new SddScriptError7(`hardeningChecked[${index}].kind must be Hardening|Checked and clean`, 2);
    if (!text2)
      throw new SddScriptError7(`hardeningChecked[${index}] needs non-empty text`, 2);
    return { kind, text: text2 };
  });
  return {
    findings,
    ...parsedVerification !== undefined ? { needsVerification: parsedVerification } : {},
    ...parsedHardening !== undefined ? { hardeningChecked: parsedHardening } : {}
  };
}
function parseCsv(value) {
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}
async function execute9(verb, input, context) {
  const id = idFor(verb);
  try {
    if (verb === "scaffold") {
      const findingsFile = resolvePath(context.cwd, required5(input.findings, "findings"));
      if (!existsSync6(findingsFile))
        throw new Error(`findings file not found: ${findingsFile}`);
      if (input.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(input.date))
        throw new SddScriptError7("--date must be YYYY-MM-DD", 2);
      if (input.sha !== undefined && !/^[0-9a-f]{7,40}$/.test(input.sha))
        throw new SddScriptError7("--sha must be a 7-40 char hex commit SHA", 2);
      const date = input.date ?? new Date().toISOString().slice(0, 10);
      const outDir = resolvePath(context.cwd, input.dir ?? `audit-${date}`);
      const payload2 = parseFindings(readFileSync11(findingsFile, "utf8"));
      let sha = input.sha;
      if (sha === undefined) {
        try {
          const out = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: context.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
          sha = out.trim();
        } catch {
          sha = "unknown";
        }
      }
      let result2;
      try {
        result2 = scaffoldAuditPlan(outDir, payload2.findings, { date, repoName: input.repo, repoShortSha: sha, needsVerification: payload2.needsVerification, hardeningChecked: payload2.hardeningChecked });
      } catch (error) {
        if (error instanceof TypeError && error.message.includes("audit.finding."))
          throw new SddScriptError7(error.message, 2);
        throw error;
      }
      return ok12(id, result2);
    }
    if (verb === "promote") {
      const auditDir = resolvePath(context.cwd, required5(input.path, "audit-dir"));
      if (!existsSync6(auditDir))
        throw new Error(`audit dir not found: ${auditDir}`);
      const selected = parseCsv(required5(input.plans, "--plans"));
      if (selected.length === 0)
        throw new SddScriptError7("--plans must select at least one plan", 2);
      const deliveryKind = required5(input.deliveryKind, "--delivery-kind");
      if (!WORKFLOW_DELIVERY_KINDS3.includes(deliveryKind))
        throw new SddScriptError7(`--delivery-kind must be one of ${WORKFLOW_DELIVERY_KINDS3.join(" | ")}`, 2);
      const harnessDir2 = resolveProcessHarnessDir13(context.cwd, input.harness);
      if (harnessDir2 === null)
        throw new Error(`harness dir not found from ${context.cwd} — pass --harness`);
      setArtifactStore7(createFsStore7(harnessDir2));
      const result2 = await registerShippedCatalogExecution2({ harnessDir: harnessDir2 }, {
        operationId: randomUUID2(),
        actor: "mcp:audit-promote",
        workflow: { kind: "audit", outDir: auditDir, selected, options: {
          harnessDir: harnessDir2,
          deliveryKind,
          ...input.workflow !== undefined ? { workflowId: input.workflow } : {},
          ...input.branchSource !== undefined ? { branchSource: input.branchSource } : {},
          ...input.branchTarget !== undefined ? { branchTarget: input.branchTarget } : {},
          ...input.completionPolicy !== undefined ? { completionPolicy: input.completionPolicy } : {}
        } }
      });
      return ok12(id, result2);
    }
    const root = resolvePath(context.cwd, input.path ?? ".");
    if (!existsSync6(root) || !statSync2(root).isDirectory())
      throw new SddScriptError7(`not a directory: ${root}`, 2);
    if (verb === "secret-scan") {
      const process2 = context.effects.spawn;
      if (process2 === undefined)
        throw new Error("secret scan process capability is unavailable");
      const listed = await process2({ argv: ["git", "ls-files", "-z", "--", "."], cwd: root, env: {}, signal: context.signal });
      if (listed.exitCode !== 0 || listed.signal !== null)
        throw new SddScriptError7("not a git repository or git unavailable — refusing to report an empty scan as clean", 2);
      const files = listed.stdout.split("\x00").filter(Boolean).map((file) => path13.join(root, file));
      const result2 = scanSecrets(files);
      return result2.unreadableFiles > 0 || result2.findings.length > 0 ? { version: 1, command: id, status: "refused", code: result2.unreadableFiles > 0 ? "audit.secret-scan.incomplete" : "audit.secret-scan.findings", exitCode: 1, message: result2.unreadableFiles > 0 ? `failed to read ${result2.unreadableFiles} tracked files; refusing to report clean` : `${result2.findings.length} secret findings`, details: { findings: result2.findings, unreadableFiles: result2.unreadableFiles } } : ok12(id, { findings: [], unreadableFiles: 0, filesScanned: files.length });
    }
    const result = supplyChainChecks(root);
    return result.ok ? ok12(id, result) : { version: 1, command: id, status: "refused", code: "audit.supply-chain.findings", exitCode: 1, message: `${result.findings.length} supply-chain findings`, details: { findings: result.findings, violations: result.violations } };
  } catch (error) {
    return failure4(id, error);
  }
}
function makeDefinition2(verb) {
  const contract3 = contracts[verb];
  const id = idFor(verb);
  const fields = [...contract3.args.map(({ key }) => key), ...contract3.options.map(({ key }) => key)];
  const input = inputSchema7.pick(Object.fromEntries(fields.map((field) => [field, true])));
  return {
    id,
    cli: { path: ["audit", verb], aliases: [], arguments: contract3.args, options: contract3.options },
    input,
    output: commandEnvelopeSchema,
    effects: contract3.effects,
    description: contract3.description,
    async execute(raw, context) {
      const parsed = input.safeParse(raw);
      return parsed.success ? execute9(verb, parsed.data, context) : { version: 1, command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: parsed.error.message };
    }
  };
}
function getAuditCommandDefinitions() {
  return verbs8.map(makeDefinition2);
}

// src/families/pr-review.ts
import { existsSync as existsSync7, readFileSync as readFileSync12, renameSync, unlinkSync, openSync, fstatSync, lstatSync, closeSync, linkSync } from "node:fs";
import path14 from "node:path";
import {
  computePrTally,
  planReviewPost,
  prReviewReportPath,
  prReviewSeatPrompt,
  prReviewSizing,
  resolvePrReviewTier,
  PR_REVIEW_TIER_BUDGETS,
  validatePrReviewReport
} from "@mstar-harness/engine";
import { randomUUID as randomUUID3 } from "node:crypto";
import { z as z15 } from "zod";
var verbs9 = ["tally", "report-path", "validate-report", "post", "worktree-cleanup", "size", "seat-prompt", "budget"];
var inputSchema8 = z15.object({
  findings: z15.string().optional(),
  unverified: z15.string().optional(),
  unmetAcUnsafe: z15.string().optional(),
  unmetAcSafe: z15.string().optional(),
  reportsDir: z15.string().optional(),
  target: z15.string().optional(),
  stage: z15.string().optional(),
  slug: z15.string().optional(),
  date: z15.string().optional(),
  reportFile: z15.string().optional(),
  pr: z15.string().optional(),
  bodyFile: z15.string().optional(),
  body: z15.string().optional(),
  worktreePath: z15.string().optional(),
  branch: z15.string().optional(),
  reportSaved: z15.boolean().optional(),
  base: z15.string().optional(),
  head: z15.string().optional(),
  largestFileTotal: z15.string().optional(),
  domain: z15.string().optional(),
  seat: z15.string().optional(),
  worktree: z15.string().optional(),
  security: z15.boolean().optional(),
  skillRoot: z15.string().optional(),
  recon: z15.array(z15.string()).optional(),
  tier: z15.string().optional(),
  diffFile: z15.string().optional(),
  collectFolded: z15.boolean().optional()
});
var contracts2 = {
  tally: { args: [], options: [{ key: "findings", flags: "--findings <file.json>", required: true }, { key: "unverified", flags: "--unverified <n>", required: false }, { key: "unmetAcUnsafe", flags: "--unmet-ac-unsafe <n>", required: false }, { key: "unmetAcSafe", flags: "--unmet-ac-safe <n>", required: false }], effects: ["read", "validate"], description: "Compute PR-review tally and verdict from accepted findings." },
  "report-path": { args: [], options: [{ key: "reportsDir", flags: "--reports-dir <dir>", required: true }, { key: "target", flags: "--target <spec>", required: true }, { key: "stage", flags: "--stage <1|2>", required: false }, { key: "slug", flags: "--slug <domain-seat>", required: false }, { key: "date", flags: "--date <YYYY-MM-DD>", required: false }], effects: ["read"], description: "Resolve a local PR-review report path without writing." },
  "validate-report": { args: [{ key: "reportFile", required: true, variadic: false }], options: [], effects: ["read", "validate"], description: "Validate a saved PR-review report." },
  post: { args: [], options: [{ key: "pr", flags: "--pr <n>", required: true }, { key: "bodyFile", flags: "--body-file <path>", required: true }, { key: "findings", flags: "--findings <file.json>", required: false }], effects: ["read", "validate", "process", "service"], description: "Post a GitHub PR review through the admitted gh process effect." },
  "worktree-cleanup": { args: [], options: [{ key: "worktreePath", flags: "--path <dir>", required: true }, { key: "branch", flags: "--branch <name>", required: true }, { key: "reportSaved", flags: "--report-saved", required: false }], effects: ["read", "write", "process"], description: "Remove a recorded PR-review worktree after its report is saved." },
  size: { args: [], options: [{ key: "base", flags: "--base <ref>", required: true }, { key: "head", flags: "--head <ref>", required: true }, { key: "largestFileTotal", flags: "--largest-file-total <n>", required: false }], effects: ["read", "process"], description: "Classify a PR-review changeset and derive tier and seats." },
  "seat-prompt": { args: [], options: [{ key: "stage", flags: "--stage <1|2>", required: true }, { key: "domain", flags: "--domain <d>", required: true }, { key: "seat", flags: "--seat <id>", required: true }, { key: "worktree", flags: "--worktree <path>", required: true }, { key: "security", flags: "--security", required: false }, { key: "skillRoot", flags: "--skill-root <dir>", required: false }, { key: "recon", flags: "--recon <facts...>", required: false }, { key: "tier", flags: "--tier <quick|default|deep>", required: false }, { key: "diffFile", flags: "--diff-file <path>", required: false }, { key: "collectFolded", flags: "--collect-folded", required: false }], effects: ["read"], description: "Generate a read-only PR-review seat prompt." },
  budget: { args: [], options: [], effects: ["read"], description: "Print PR-review tier budgets." }
};
var idFor2 = (verb) => `pr-review.${verb}`;
var ok13 = (id, data) => ({ version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data });
var failure5 = (id, error) => error instanceof UsageError2 ? { version: 1, command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: error.message } : { version: 1, command: id, status: "error", code: `${id}.failed`, exitCode: 1, message: error instanceof Error ? error.message : String(error) };

class UsageError2 extends Error {
}
var abs = (cwd, file) => path14.isAbsolute(file) ? file : path14.resolve(cwd, file);
var need = (value, name) => {
  if (value === undefined || value === "")
    throw new UsageError2(`${name} is required`);
  return value;
};
function parseTarget(raw) {
  const colon = raw.indexOf(":");
  const kind = colon < 0 ? raw : raw.slice(0, colon);
  const value = colon < 0 ? "" : raw.slice(colon + 1);
  if (kind === "pr" && /^\d+$/.test(value) && Number(value) > 0)
    return { kind: "pr", n: Number(value) };
  if (kind === "branch" && value !== "")
    return { kind: "branch", slug: value };
  if (kind === "diff" && value === "")
    return { kind: "diff" };
  if (kind === "diff")
    return { kind: "diff", headSha: value };
  throw new UsageError2(`invalid --target ${JSON.stringify(raw)}; expected pr:<n> | branch:<slug> | diff:<sha> | diff`);
}
async function spawn(context, argv, cwd = context.cwd, stdin) {
  return context.effects.spawn({ argv, cwd, env: {}, ...stdin !== undefined ? { stdin } : {}, signal: context.signal });
}
function parseFinding(entry, index) {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry))
    return null;
  const row = entry;
  if (row.path === undefined && row.body === undefined && row.line === undefined)
    return null;
  if (typeof row.path !== "string" || !row.path.trim() || typeof row.body !== "string" || !row.body.trim() || typeof row.line !== "number" || !Number.isInteger(row.line) || row.line < 1)
    throw new UsageError2(`findings[${index}] must be {path: string, line: number >= 1, body: string}`);
  return { path: row.path, line: row.line, side: "RIGHT", body: row.body };
}
function foldComments(body, dropped) {
  return [
    ...body.split(/\r?\n/),
    "",
    "## Inline comments folded into this summary",
    "",
    ...dropped.map((entry) => `- \`${entry.path}:${entry.line}\` — ${entry.body}`)
  ].join(`
`);
}
async function execute10(verb, input, context) {
  const id = idFor2(verb);
  try {
    if (verb === "tally") {
      const file = abs(context.cwd, need(input.findings, "--findings"));
      if (!existsSync7(file))
        throw new Error(`findings file not found: ${file}`);
      const parsed = JSON.parse(readFileSync12(file, "utf8"));
      if (!Array.isArray(parsed))
        throw new UsageError2("findings file must be a JSON array of {mergeClass} objects");
      const allowed = ["must-fix", "should-fix", "nit"];
      const findings = parsed.map((row, index) => {
        const mergeClass = row && typeof row === "object" && !Array.isArray(row) ? row.mergeClass : undefined;
        if (typeof mergeClass !== "string" || !allowed.includes(mergeClass))
          throw new UsageError2(`findings[${index}].mergeClass must be one of ${allowed.join(" | ")}`);
        return { mergeClass };
      });
      const count = (raw, label) => {
        if (raw === undefined)
          return 0;
        if (!/^\d+$/.test(raw) || Number(raw) > 50)
          throw new UsageError2(`${label} must be a non-negative integer no greater than 50`);
        return Number(raw);
      };
      const result = computePrTally({ findings, unverifiedCount: count(input.unverified, "--unverified"), unmetAc: [...Array.from({ length: count(input.unmetAcUnsafe, "--unmet-ac-unsafe") }, () => ({ unsafeToShip: true })), ...Array.from({ length: count(input.unmetAcSafe, "--unmet-ac-safe") }, () => ({ unsafeToShip: false }))] });
      return ok13(id, result);
    }
    if (verb === "report-path") {
      const stage = input.stage === undefined ? undefined : input.stage === "1" ? 1 : input.stage === "2" ? 2 : (() => {
        throw new UsageError2("--stage must be 1 or 2");
      })();
      if (stage !== undefined !== (input.slug !== undefined))
        throw new UsageError2("--stage and --slug go together");
      if (input.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(input.date))
        throw new UsageError2("--date must be YYYY-MM-DD");
      return ok13(id, { path: prReviewReportPath({ reportsDir: abs(context.cwd, need(input.reportsDir, "--reports-dir")), target: parseTarget(need(input.target, "--target")), ...stage ? { stage } : {}, ...input.slug ? { slug: input.slug } : {}, ...input.date ? { date: input.date } : {} }) });
    }
    if (verb === "validate-report") {
      const file = abs(context.cwd, need(input.reportFile, "report file"));
      if (!existsSync7(file))
        throw new Error(`report file not found: ${file}`);
      const result = validatePrReviewReport(readFileSync12(file, "utf8"));
      return result.ok ? ok13(id, result) : { version: 1, command: id, status: "refused", code: `${id}.invalid`, exitCode: 1, message: "PR-review report validation failed", details: { violations: result.violations } };
    }
    if (verb === "post") {
      if (!/^\d+$/.test(need(input.pr, "--pr")) || Number(input.pr) < 1)
        throw new UsageError2("--pr requires a positive integer");
      const bodyFile = abs(context.cwd, need(input.bodyFile, "--body-file"));
      if (!existsSync7(bodyFile))
        throw new Error(`body file not found: ${bodyFile}`);
      const body = readFileSync12(bodyFile, "utf8");
      let comments = [];
      if (input.findings !== undefined) {
        const findingsFile = abs(context.cwd, input.findings);
        if (!existsSync7(findingsFile))
          throw new Error(`findings file not found: ${findingsFile}`);
        const parsed = JSON.parse(readFileSync12(findingsFile, "utf8"));
        if (!Array.isArray(parsed))
          throw new UsageError2("--findings must be a JSON array");
        comments = parsed.flatMap((entry, index) => {
          const value = parseFinding(entry, index);
          return value ? [value] : [];
        });
      }
      const viewResult = await spawn(context, ["gh", "pr", "view", String(Number(input.pr)), "--json", "url,headRefOid"]);
      if (viewResult.exitCode !== 0 || viewResult.signal !== null) {
        return { version: 1, command: id, status: "refused", code: `${id}.unauthorized`, exitCode: 1, message: viewResult.stderr || "GitHub authentication/target lookup failed" };
      }
      const plan = planReviewPost(JSON.parse(viewResult.stdout), { body, comments });
      if (plan.pr !== Number(input.pr)) {
        return { version: 1, command: id, status: "refused", code: `${id}.wrong-target`, exitCode: 1, message: `resolved PR ${plan.pr} does not match requested PR ${input.pr}` };
      }
      const apiPath = `repos/${plan.ownerRepo}/pulls/${plan.pr}/reviews`;
      const payload2 = (kept, dropped) => JSON.stringify({ commit_id: plan.commitId, event: plan.event, body: dropped.length ? foldComments(plan.body, dropped) : plan.body, ...kept.length ? { comments: kept.map(({ path: filePath, line, side, body: commentBody }) => ({ path: filePath, line, side, body: commentBody })) } : {} });
      const send = (kept, dropped) => spawn(context, ["gh", "api", "--method", "POST", apiPath, "--input", "-"], context.cwd, payload2(kept, dropped));
      let response = await send(plan.inlineComments, []);
      if (response.exitCode !== 0 && /HTTP\s+422|"status"\s*:\s*422/.test(`${response.stderr}
${response.stdout}`) && plan.inlineComments.length)
        response = await send([], plan.inlineComments);
      if (response.exitCode !== 0 || response.signal !== null)
        throw new Error(response.stderr || "gh api review post failed");
      let reviewUrl = response.stdout.trim();
      try {
        const parsed = JSON.parse(response.stdout);
        if (typeof parsed.html_url === "string")
          reviewUrl = parsed.html_url;
      } catch {}
      return ok13(id, { posted: true, comments: "posted", review_url: reviewUrl || "(gh response)" });
    }
    if (verb === "worktree-cleanup") {
      const worktreePath = path14.resolve(abs(context.cwd, need(input.worktreePath, "--path")));
      const sidecarPath = path14.join(path14.dirname(worktreePath), `.${path14.basename(worktreePath)}.prreview.json`);
      if (!existsSync7(sidecarPath))
        throw new Error(`no setup sidecar found at ${sidecarPath} - run pr-review worktree-setup first`);
      const sidecar = JSON.parse(readFileSync12(sidecarPath, "utf8"));
      const branch = sidecar.reviewBranch ?? "";
      if (branch === "" ? input.branch !== "" : input.branch !== branch)
        throw new Error(`--branch does not match the recorded review branch ${JSON.stringify(branch)} - refusing to delete a foreign branch`);
      if (input.reportSaved !== true && sidecar.reportSaved !== true)
        throw new Error("refusing cleanup: the local report is not saved yet - save it first or pass --report-saved");
      const gitRoot = typeof sidecar.repoRoot === "string" && sidecar.repoRoot !== "" ? sidecar.repoRoot : path14.dirname(worktreePath);
      if (existsSync7(worktreePath)) {
        const removed = await spawn(context, ["git", "worktree", "remove", worktreePath], gitRoot);
        if (removed.exitCode !== 0 || removed.signal !== null)
          throw new Error(removed.stderr || "git worktree remove failed");
      }
      const pruned = await spawn(context, ["git", "worktree", "prune"], gitRoot);
      if (pruned.exitCode !== 0 || pruned.signal !== null)
        throw new Error(pruned.stderr || "git worktree prune failed");
      if (branch) {
        const branchCheck = await spawn(context, ["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], gitRoot);
        if (branchCheck.exitCode !== 0 || branchCheck.signal !== null)
          throw new Error(`recorded review branch ${branch} no longer resolves - refusing ambiguous cleanup`);
        const deleted = await spawn(context, ["git", "branch", "-D", branch], gitRoot);
        if (deleted.exitCode !== 0 || deleted.signal !== null)
          throw new Error(deleted.stderr || `failed to delete ${branch}`);
      }
      const diffPath = path14.join(path14.dirname(worktreePath), `.${path14.basename(worktreePath)}.prreview.diff`);
      try {
        const fd = openSync(diffPath, "r");
        try {
          const st = fstatSync(fd);
          if (st.isFile() && typeof sidecar.diffFileIno === "string" && st.dev === sidecar.diffFileDev && String(st.ino) === sidecar.diffFileIno && st.mtimeMs === sidecar.diffFileMtimeMs && st.nlink === 1) {
            const tmp = `${diffPath}.cleanup.${process.pid}.${randomUUID3()}`;
            renameSync(diffPath, tmp);
            const after = fstatSync(fd);
            const moved = lstatSync(tmp);
            if (moved.dev === after.dev && moved.ino === after.ino && after.nlink === 1 && moved.nlink === 1)
              unlinkSync(tmp);
            else {
              linkSync(tmp, diffPath);
              unlinkSync(tmp);
            }
          }
        } finally {
          closeSync(fd);
        }
      } catch {}
      unlinkSync(sidecarPath);
      return ok13(id, { removed: worktreePath, branch: branch || null });
    }
    if (verb === "size") {
      const base = need(input.base, "--base");
      const head = need(input.head, "--head");
      const rootResult = await spawn(context, ["git", "rev-parse", "--show-toplevel"]);
      if (rootResult.exitCode !== 0 || rootResult.signal !== null)
        throw new Error(rootResult.stderr || "not a git repository");
      const root = rootResult.stdout.trim();
      const diff = await spawn(context, ["git", "diff", `${base}...${head}`], root);
      const numstat = await spawn(context, ["git", "diff", "--numstat", `${base}...${head}`], root);
      if (diff.exitCode !== 0 || diff.signal !== null || numstat.exitCode !== 0 || numstat.signal !== null)
        throw new Error(diff.stderr || numstat.stderr || "git diff failed");
      const changedLines = numstat.stdout.split(/\r?\n/).reduce((sum, line) => {
        const match = /^(\d+)\t(\d+)\t/.exec(line);
        return sum + (match ? Number(match[1]) + Number(match[2]) : 0);
      }, 0);
      let largestTouchedFileTotal;
      if (input.largestFileTotal !== undefined) {
        if (!/^\d+$/.test(input.largestFileTotal))
          throw new UsageError2("--largest-file-total must be a non-negative integer");
        largestTouchedFileTotal = Number(input.largestFileTotal);
      } else {
        const files = [...new Set([...diff.stdout.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1]))];
        for (const file of files) {
          const content = await spawn(context, ["git", "show", `${head}:${file}`], root);
          if (content.signal !== null)
            throw new Error(content.stderr || "git show failed");
          const total = content.exitCode === 0 ? content.stdout === "" ? 0 : content.stdout.split(`
`).length : 0;
          largestTouchedFileTotal = largestTouchedFileTotal === undefined ? total : Math.max(largestTouchedFileTotal, total);
        }
      }
      const sizing = prReviewSizing({ changedLines, ...largestTouchedFileTotal !== undefined ? { largestTouchedFileTotal } : {} });
      return ok13(id, { ...sizing, tier: resolvePrReviewTier({ band: sizing.band }), changedLines });
    }
    if (verb === "seat-prompt") {
      if (input.stage !== "1" && input.stage !== "2")
        throw new UsageError2("--stage must be 1 or 2");
      if (input.tier !== undefined && !["quick", "default", "deep"].includes(input.tier))
        throw new UsageError2("--tier must be quick | default | deep");
      const skillRoot = abs(context.cwd, input.skillRoot ?? "skills/mstar-audit");
      return ok13(id, { prompt: prReviewSeatPrompt({ stage: input.stage === "1" ? 1 : 2, domain: need(input.domain, "--domain"), seat: need(input.seat, "--seat"), skillRoot, worktreePath: path14.resolve(need(input.worktree, "--worktree")), reconFacts: input.recon ?? [], ...input.security ? { securitySeat: true } : {}, ...input.tier ? { tier: input.tier } : {}, ...input.diffFile ? { diffFile: abs(context.cwd, input.diffFile) } : {}, ...input.collectFolded ? { collectFolded: true } : {} }) });
    }
    return ok13(id, { budgets: PR_REVIEW_TIER_BUDGETS });
  } catch (error) {
    return failure5(id, error);
  }
}
function getPrReviewCommandDefinitions() {
  return verbs9.map((verb) => {
    const contract3 = contracts2[verb];
    const id = idFor2(verb);
    const fields = [...contract3.args.map(({ key }) => key), ...contract3.options.map(({ key }) => key)];
    return {
      id,
      cli: { path: ["pr-review", verb], aliases: [], arguments: contract3.args, options: contract3.options },
      input: inputSchema8.pick(Object.fromEntries(fields.map((field) => [field, true]))),
      output: commandEnvelopeSchema,
      effects: contract3.effects,
      description: contract3.description,
      async execute(raw, context) {
        const parsed = inputSchema8.pick(Object.fromEntries(fields.map((field) => [field, true]))).safeParse(raw);
        return parsed.success ? execute10(verb, parsed.data, context) : failure5(id, new UsageError2(parsed.error.message));
      }
    };
  });
}

// src/families/judgment.ts
import { resolve } from "node:path";
import { z as z16 } from "zod";
var id = "judgment.review-advice";
var inputSchema9 = z16.object({
  file: z16.string().optional(),
  stdin: z16.boolean().optional(),
  pilot: z16.string().min(1),
  workspace: z16.string().optional(),
  json: z16.boolean().optional()
});
async function lazyJudgmentProvider({ invocation, signal, readInput }) {
  const judgmentPackage = "@mstar-harness/judgment";
  const judgment = await import(judgmentPackage);
  return judgment.runReviewAdvice(invocation, signal, null, {
    readStdin: async () => new TextEncoder().encode(await readInput()),
    isStdinTTY: () => false
  });
}
function usage7(message) {
  return { version: 1, command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message };
}
function error(code, message, boundary) {
  return {
    version: 1,
    command: id,
    status: "error",
    code,
    exitCode: 1,
    message,
    ...boundary === undefined ? {} : { details: { boundary } }
  };
}
async function execute11(input, context, provider) {
  const hasFile = input.file !== undefined;
  const hasStdin = input.stdin === true;
  if (hasFile === hasStdin)
    return usage7("exactly one of file or stdin is required");
  const invocation = Object.freeze({
    cwd: context.cwd,
    workspace: resolve(context.cwd, input.workspace ?? "."),
    input: hasStdin ? Object.freeze({ kind: "stdin" }) : Object.freeze({ kind: "file", path: input.file }),
    pilotPath: input.pilot
  });
  let result;
  try {
    result = await provider(Object.freeze({ invocation, signal: context.signal, readInput: () => context.effects.readInput() }));
  } catch (cause) {
    return error("judgment.provider-failed", "Judgment provider invocation failed", cause instanceof Error ? cause.message : String(cause));
  }
  if (result.status === "invalid")
    return usage7("Judgment input was rejected");
  if (result.status === "cancelled") {
    return { version: 1, command: id, status: "error", code: "judgment.cancelled", exitCode: 130, message: "Judgment review was cancelled", details: { boundary: result.code ?? "review-cancelled" } };
  }
  if (result.status === "unavailable")
    return error("judgment.provider-failed", "Judgment provider is unavailable", result.code ?? "provider-unavailable");
  return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data: result };
}
function getJudgmentCommandDefinitions(provider = lazyJudgmentProvider) {
  const definition2 = {
    id,
    cli: {
      path: ["judgment", "review-advice"],
      aliases: [],
      arguments: [],
      options: [
        { key: "file", flags: "--file <path>", required: false },
        { key: "stdin", flags: "--stdin", required: false },
        { key: "pilot", flags: "--pilot <path>", required: true },
        { key: "workspace", flags: "--workspace <path>", required: false },
        { key: "json", flags: "--json", required: false }
      ]
    },
    input: inputSchema9,
    output: commandEnvelopeSchema,
    effects: ["read", "stdin", "service"],
    description: "Submit an explicitly enabled review pack for bounded, non-authoritative advice.",
    async execute(raw, context) {
      const parsed = inputSchema9.safeParse(raw);
      if (!parsed.success)
        return usage7(parsed.error.message);
      return execute11(parsed.data, context, provider);
    }
  };
  return [definition2];
}

// src/families/process.ts
import fs from "node:fs";
import { createHash } from "node:crypto";
import path15 from "node:path";
import { SddScriptError as SddScriptError8, checkSddAction as checkSddAction2, pickReviewBranchName, preflightChangeset, resolveProcessHarnessDir as resolveProcessHarnessDir14, resolveSddExecutionContext as resolveSddExecutionContext2, readMainWorktree, readWorkflowSnapshot as readWorkflowSnapshot3, planWorktreeCleanup, resolveWorkflowDir as resolveWorkflowDir4, WORKFLOW_SNAPSHOT_FILE as WORKFLOW_SNAPSHOT_FILE3 } from "@mstar-harness/engine";
import { z as z17 } from "zod";
var execInput = z17.object({ context: z17.string(), argv: z17.array(z17.string()).min(1) });
var cleanupInput = z17.object({ workflow: z17.string(), harness: z17.string().optional(), apply: z17.boolean().optional(), remote: z17.boolean().optional(), worktree: z17.array(z17.string()).optional(), allWorkflows: z17.boolean().optional(), verbose: z17.boolean().optional(), ignoreUnreadableSnapshots: z17.boolean().optional() });
var setupInput = z17.object({ pr: z17.string().optional(), branch: z17.string().optional(), diff: z17.boolean().optional(), workingTree: z17.boolean().optional(), commit: z17.string().optional(), targetPath: z17.string().optional() });
function ok14(id2, data) {
  return { version: 1, command: id2, status: "ok", code: `${id2}.ok`, exitCode: 0, data };
}
function failure6(id2, error2) {
  const message = error2 instanceof Error ? error2.message : String(error2);
  if (error2 instanceof SddScriptError8 && error2.exitCode === 2)
    return { version: 1, command: id2, status: "usage", code: "command.invalid-input", exitCode: 2, message };
  if (error2 instanceof SddScriptError8)
    return { version: 1, command: id2, status: "error", code: `${id2}.refused`, exitCode: error2.exitCode, message };
  if (error2 !== null && typeof error2 === "object" && "exitCode" in error2 && typeof error2.exitCode === "number") {
    return { version: 1, command: id2, status: "error", code: "command.child-failed", exitCode: error2.exitCode, message };
  }
  const code = error2 !== null && typeof error2 === "object" && "code" in error2 && typeof error2.code === "string" ? error2.code : `${id2}.refused`;
  return { version: 1, command: id2, status: "refused", code, exitCode: error2 instanceof SddScriptError8 ? error2.exitCode : 1, message };
}
function definitions() {
  const make = (id2, input, args, options, effects, description, execute12) => ({ id: id2, cli: { path: id2 === "pr-review.worktree-setup" ? ["pr-review", "worktree-setup"] : id2.split(".").map((part) => part.replace("-", " ")).flatMap((part) => part.split(" ")), aliases: [], arguments: args, options }, input, output: commandEnvelopeSchema, effects, description, execute: execute12 });
  return [
    make("sdd.exec", execInput, [{ key: "argv", required: true, variadic: true }], [{ key: "context", flags: "--context <path>", required: false }], ["read", "validate", "process"], "Run an admitted literal argv child in the SDD feature worktree.", async (input, invocation) => {
      try {
        if (!input.context || !path15.isAbsolute(input.context))
          throw new SddScriptError8("usage: sdd exec --context <absolute.json> -- <executable> [args...]", 2);
        if (!input.argv?.length)
          throw new SddScriptError8("argv after -- must include the child executable", 2);
        const decoded = JSON.parse(fs.readFileSync(input.context, "utf8"));
        if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded))
          throw new SddScriptError8("context file must contain a JSON object", 2);
        const context = resolveSddExecutionContext2(decoded);
        const gate = checkSddAction2(context, { kind: "launch", cwd: invocation.cwd });
        if (!gate.ok)
          throw new SddScriptError8(gate.violations.map(({ code, message }) => `${code}: ${message}`).join("; "), 1);
        if (invocation.signal.aborted)
          throw Object.assign(new Error("process admission cancelled"), { code: "command.cancelled" });
        const child = await invocation.effects.spawn({ argv: input.argv, cwd: context.featureCwd, env: { ...process.env }, signal: invocation.signal });
        if (child.exitCode === 0)
          return ok14("sdd.exec", { stdout: child.stdout, stderr: child.stderr, signal: child.signal });
        return { version: 1, command: "sdd.exec", status: "error", code: "sdd.exec.child-exit", exitCode: child.exitCode ?? 1, message: child.signal ? `child terminated by ${child.signal}` : `child exited with status ${child.exitCode}`, details: { stdout: child.stdout, stderr: child.stderr, signal: child.signal } };
      } catch (error2) {
        return failure6("sdd.exec", error2);
      }
    }),
    make("worktree.cleanup", cleanupInput, [], [{ key: "workflow", flags: "--workflow <id>", required: false }, { key: "harness", flags: "--harness <path>", required: false }, { key: "apply", flags: "--apply", required: false }, { key: "remote", flags: "--remote", required: false }, { key: "worktree", flags: "--worktree <path>", required: false }, { key: "allWorkflows", flags: "--all-workflows", required: false }, { key: "verbose", flags: "--verbose", required: false }, { key: "ignoreUnreadableSnapshots", flags: "--ignore-unreadable-snapshots", required: false }], ["read", "write", "process"], "Plan and optionally execute guarded worktree/branch cleanup. Dry-run by default; apply uses ownership, merge-evidence, active-lease, checked-out, foreign, dirty, locked, and non-terminal protections.", async (input, invocation) => {
      try {
        if (!input.workflow)
          throw new SddScriptError8("usage: worktree cleanup --workflow <id>", 2);
        return await cleanupWorktrees(input, invocation);
      } catch (error2) {
        return failure6("worktree.cleanup", error2);
      }
    }),
    make("pr-review.worktree-setup", setupInput, [], [{ key: "pr", flags: "--pr <n>", required: false }, { key: "branch", flags: "--branch <name>", required: false }, { key: "diff", flags: "--diff", required: false }, { key: "workingTree", flags: "--working-tree", required: false }, { key: "commit", flags: "--commit <sha>", required: false }, { key: "targetPath", flags: "--path <dir>", required: false }], ["read", "write", "process"], "Create an isolated review worktree: resolve the base, fetch explicit refs, run one admitted input mode, compute its diff basis inside the worktree, and write an identity-bound sidecar and diff snapshot.", async (input, invocation) => {
      try {
        return await setupReviewWorktree(input, invocation);
      } catch (error2) {
        return failure6("pr-review.worktree-setup", error2);
      }
    })
  ];
}
function getProcessCommandDefinitions() {
  return definitions();
}
async function processReply(invocation, argv, cwd) {
  if (invocation.signal.aborted)
    throw Object.assign(new Error("process admission cancelled"), { code: "command.cancelled" });
  return invocation.effects.spawn({ argv, cwd, env: Object.fromEntries(Object.entries(process.env).filter((entry) => entry[1] !== undefined)), signal: invocation.signal });
}
async function git(invocation, args, cwd) {
  const result = await processReply(invocation, ["git", ...args], cwd);
  if (result.exitCode !== 0)
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} exited ${result.exitCode}`);
  return result.stdout.trim();
}
async function gitProbe(invocation, args, cwd) {
  const result = await processReply(invocation, ["git", ...args], cwd);
  return result.exitCode === 0 ? result.stdout.trim() : "";
}
async function setupReviewWorktree(input, invocation) {
  const modes = [input.pr !== undefined, input.branch !== undefined, input.diff === true, input.workingTree === true, input.commit !== undefined].filter(Boolean).length;
  if (modes !== 1)
    throw new SddScriptError8("usage: pr-review worktree-setup requires exactly one of --pr, --branch, --diff, --working-tree, or --commit", 2);
  const repoRoot = await git(invocation, ["rev-parse", "--show-toplevel"], invocation.cwd);
  const mode = input.pr !== undefined ? "pr" : input.branch !== undefined ? "branch" : input.diff ? "diff" : input.workingTree ? "working-tree" : "commit";
  if (mode === "pr" && !/^\d+$/.test(input.pr))
    throw new SddScriptError8(`usage: --pr requires a positive integer PR number, got ${JSON.stringify(input.pr)}`, 2);
  if (mode === "diff" || mode === "working-tree") {
    if (mode === "working-tree") {
      const status = await git(invocation, ["status", "--porcelain"], repoRoot);
      const gate = preflightChangeset(mode, { refsResolve: true, changesetEmpty: status === "" });
      if (!gate.ok)
        return { version: 1, command: "pr-review.worktree-setup", status: "error", code: gate.violations[0]?.code ?? "prreview.preflight.changeset-empty", exitCode: 1, message: gate.violations.map(({ message }) => message).join("; ") };
    }
    return ok14("pr-review.worktree-setup", { reviewBranch: null, worktreePath: repoRoot, base: null, mergeBase: null, diffCmd: mode === "diff" ? "(provided changeset)" : "git diff + git diff --cached + ls-files --others", diffFile: null });
  }
  let baseRef = "";
  let headSpec = input.commit ?? input.branch ?? "";
  let prNumber = 0;
  if (mode === "pr") {
    prNumber = Number(input.pr);
    const gh = await processReply(invocation, ["gh", "pr", "view", String(prNumber), "--json", "baseRefName", "--jq", ".baseRefName"], repoRoot);
    if (gh.exitCode !== 0)
      throw new Error(gh.stderr.trim() || `gh pr view exited ${gh.exitCode}`);
    baseRef = gh.stdout.trim();
    if (baseRef === "")
      throw new Error(`gh pr view returned an empty base ref for PR ${prNumber}`);
    headSpec = `pull/${prNumber}/head`;
  } else if (mode === "branch") {
    baseRef = (await gitProbe(invocation, ["symbolic-ref", "refs/remotes/origin/HEAD"], repoRoot)).replace("refs/remotes/origin/", "");
    if (!baseRef) {
      const remoteHeads = await gitProbe(invocation, ["ls-remote", "--symref", "origin", "HEAD"], repoRoot);
      baseRef = /ref: refs\/heads\/(\S+)\s+HEAD/.exec(remoteHeads)?.[1] ?? "";
    }
    if (!baseRef && await gitProbe(invocation, ["rev-parse", "--verify", "--quiet", "origin/main"], repoRoot))
      baseRef = "main";
    if (!baseRef)
      throw new SddScriptError8("prreview.preflight.refs-unresolved: cannot resolve origin default branch", 1);
  } else {
    if (!await gitProbe(invocation, ["rev-parse", "--verify", "--quiet", `${headSpec}^{commit}`], repoRoot))
      throw new SddScriptError8("prreview.preflight.refs-unresolved: commit does not resolve", 1);
    const defaultBranch = (await gitProbe(invocation, ["symbolic-ref", "refs/remotes/origin/HEAD"], repoRoot)).replace("refs/remotes/origin/", "");
    baseRef = defaultBranch && await gitProbe(invocation, ["rev-parse", "--verify", "--quiet", `origin/${defaultBranch}`], repoRoot) ? `origin/${defaultBranch}` : `${headSpec}^`;
  }
  const existing = new Set((await git(invocation, ["for-each-ref", "--format=%(refname:short)", "refs/heads"], repoRoot)).split(/\r?\n/).filter(Boolean));
  const seed = mode === "pr" ? prNumber : Math.abs([...headSpec].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 1000003, 7)) || 1;
  const reviewBranch = pickReviewBranchName(existing, seed, new Date().toISOString().slice(0, 10).replace(/-/g, ""));
  const worktreePath = path15.resolve(input.targetPath ?? path15.join(repoRoot, ".worktrees", `review-${reviewBranch}${mode === "pr" ? "" : `-${headSpec.slice(0, 8)}`}`));
  if (input.targetPath === undefined) {
    fs.mkdirSync(path15.join(repoRoot, ".worktrees"), { recursive: true });
    if (await gitProbe(invocation, ["check-ignore", ".worktrees/"], repoRoot) === "") {
      const exclude = path15.resolve(repoRoot, await git(invocation, ["rev-parse", "--git-path", "info/exclude"], repoRoot));
      const contents = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
      if (!contents.split(`
`).some((line) => line.trim() === ".worktrees/"))
        fs.appendFileSync(exclude, `${contents === "" || contents.endsWith(`
`) ? "" : `
`}.worktrees/
`);
    }
  }
  const origin = await gitProbe(invocation, ["remote", "get-url", "origin"], repoRoot);
  let fetched = true;
  if (origin) {
    try {
      const base = baseRef.replace(/^origin\//, "");
      await git(invocation, ["fetch", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`], repoRoot);
      if (mode === "pr")
        await git(invocation, ["fetch", "origin", `+${headSpec}:${reviewBranch}`], repoRoot);
      else if (mode === "branch")
        await git(invocation, ["fetch", "origin", `+refs/heads/${headSpec}:refs/remotes/origin/${headSpec}`], repoRoot);
    } catch {
      fetched = false;
    }
  }
  const recordedBase = mode === "commit" ? baseRef : `origin/${baseRef.replace(/^origin\//, "")}`;
  const headRef = mode === "pr" ? reviewBranch : mode === "branch" ? `origin/${headSpec}` : headSpec;
  const baseResolved = mode === "commit" && baseRef === `${headSpec}^` || Boolean(await gitProbe(invocation, ["rev-parse", "--verify", "--quiet", `${recordedBase}^{commit}`], repoRoot));
  const resolved = Boolean(await gitProbe(invocation, ["rev-parse", "--verify", "--quiet", `${headRef}^{commit}`], repoRoot)) && baseResolved && (mode !== "branch" || origin !== "");
  const diffCheck = await processReply(invocation, ["git", "diff", "--quiet", mode === "commit" ? `${headSpec}^...${headSpec}` : `${recordedBase}...${headRef}`], repoRoot);
  const changesetEmpty = diffCheck.exitCode === 0;
  const admission = preflightChangeset(mode, { refsResolve: resolved && fetched, changesetEmpty });
  if (!admission.ok)
    return { version: 1, command: "pr-review.worktree-setup", status: "error", code: admission.violations[0]?.code ?? "prreview.preflight.refs-unresolved", exitCode: 1, message: admission.violations.map(({ message }) => message).join("; ") };
  let createdWorktree = false;
  try {
    if (mode === "pr")
      await git(invocation, ["worktree", "add", worktreePath, reviewBranch], repoRoot);
    else if (mode === "branch")
      await git(invocation, ["worktree", "add", "--detach", worktreePath, headRef], repoRoot);
    else
      await git(invocation, ["worktree", "add", "--detach", worktreePath, headSpec], repoRoot);
    createdWorktree = true;
    const mergeBase = await gitProbe(invocation, ["merge-base", recordedBase, headRef], worktreePath);
    const range = `${recordedBase}...${headRef}`;
    const diffCmd = mode === "commit" ? `git show ${headSpec}` : `git diff ${range}`;
    const parts = mode === "commit" ? [`# Review package: ${recordedBase} (single commit)

## Commits
`, await git(invocation, ["log", "--oneline", "-1", headSpec], worktreePath), `

## Files changed
`, await git(invocation, ["show", "--stat", headSpec], worktreePath), `

## Diff
`, await git(invocation, ["show", "-U10", headSpec], worktreePath)] : [`# Review package: ${recordedBase}..${headRef}

## Commits
`, await git(invocation, ["log", "--oneline", `${recordedBase}..${headRef}`], worktreePath), `

## Files changed
`, await git(invocation, ["diff", "--stat", range], worktreePath), `

## Diff
`, await git(invocation, ["diff", "-U10", range], worktreePath)];
    const diffText = parts.join("");
    const diffFile = path15.join(path15.dirname(worktreePath), `.${path15.basename(worktreePath)}.prreview.diff`);
    const sidecarFile = path15.join(path15.dirname(worktreePath), `.${path15.basename(worktreePath)}.prreview.json`);
    let diffFd;
    let sidecarFd;
    let snapshotStat;
    try {
      sidecarFd = fs.openSync(sidecarFile, "wx+");
      const sidecar = { reviewBranch: mode === "pr" ? reviewBranch : "", worktreePath, base: recordedBase, mergeBase, diffCmd, reportSaved: false, createdAt: new Date().toISOString(), repoRoot, diffFile, diffFileSha256: createHash("sha256").update(diffText).digest("hex") };
      fs.writeSync(sidecarFd, JSON.stringify(sidecar, null, 2));
      diffFd = fs.openSync(diffFile, "wx");
      fs.writeFileSync(diffFd, diffText);
      const stat = fs.fstatSync(diffFd);
      snapshotStat = { dev: stat.dev, ino: stat.ino };
      fs.ftruncateSync(sidecarFd, 0);
      fs.writeSync(sidecarFd, JSON.stringify({ ...sidecar, diffFileDev: stat.dev, diffFileIno: String(stat.ino), diffFileMtimeMs: stat.mtimeMs }, null, 2), 0);
      fs.closeSync(diffFd);
      diffFd = undefined;
      fs.closeSync(sidecarFd);
      sidecarFd = undefined;
      return ok14("pr-review.worktree-setup", { reviewBranch: mode === "pr" ? reviewBranch : null, worktreePath, base: recordedBase, mergeBase: mergeBase || null, diffCmd, diffFile });
    } catch (error2) {
      if (diffFd !== undefined) {
        const openStat = fs.fstatSync(diffFd);
        fs.closeSync(diffFd);
        try {
          const pathStat = fs.lstatSync(diffFile);
          if (pathStat.dev === openStat.dev && pathStat.ino === openStat.ino)
            fs.unlinkSync(diffFile);
        } catch {}
      } else if (snapshotStat !== undefined) {
        try {
          const pathStat = fs.lstatSync(diffFile);
          if (pathStat.dev === snapshotStat.dev && pathStat.ino === snapshotStat.ino)
            fs.unlinkSync(diffFile);
        } catch {}
      }
      if (sidecarFd !== undefined) {
        const openStat = fs.fstatSync(sidecarFd);
        fs.closeSync(sidecarFd);
        try {
          const pathStat = fs.lstatSync(sidecarFile);
          if (pathStat.dev === openStat.dev && pathStat.ino === openStat.ino)
            fs.unlinkSync(sidecarFile);
        } catch {}
      }
      if (createdWorktree) {
        await gitProbe(invocation, ["worktree", "remove", "--force", worktreePath], repoRoot);
        await gitProbe(invocation, ["worktree", "prune"], repoRoot);
        if (mode === "pr" && !existing.has(reviewBranch))
          await gitProbe(invocation, ["branch", "-D", reviewBranch], repoRoot);
        createdWorktree = false;
      }
      throw error2;
    }
  } catch (error2) {
    if (createdWorktree) {
      await gitProbe(invocation, ["worktree", "remove", "--force", worktreePath], repoRoot);
      await gitProbe(invocation, ["worktree", "prune"], repoRoot);
      if (mode === "pr" && !existing.has(reviewBranch))
        await gitProbe(invocation, ["branch", "-D", reviewBranch], repoRoot);
    }
    throw error2;
  }
}
function cleanupClaims(snapshot, field, value) {
  const claims = [];
  const pathKey = (candidate) => {
    try {
      return fs.realpathSync(candidate);
    } catch {
      return path15.resolve(candidate);
    }
  };
  if (field === "branch" && snapshot.branch?.integration === value)
    claims.push({ workflowId: snapshot.id });
  if (field === "path" && [snapshot.integration_worktree_path, snapshot.control_worktree_path].some((candidate) => typeof candidate === "string" && pathKey(candidate) === pathKey(value)))
    claims.push({ workflowId: snapshot.id });
  for (const row of snapshot.plans) {
    const lease = row.execution_lease;
    const meta = row.metadata;
    const handoff = row.coordination?.handoff;
    const handedOff = row.status === "Done" && handoff?.state === "completed" && typeof handoff.source_branch === "string" && handoff.source_branch !== "" && typeof handoff.worktree_path === "string" && handoff.worktree_path !== "";
    const matches = field === "branch" ? lease?.working_branch === value || meta?.working_branch === value || Array.isArray(meta?.track_branches) && meta.track_branches.includes(value) || handedOff && handoff.source_branch === value : typeof lease?.worktree_path === "string" && pathKey(lease.worktree_path) === pathKey(value) || typeof meta?.worktree_path === "string" && pathKey(meta.worktree_path) === pathKey(value) || Array.isArray(meta?.cleanup_protective_worktree_paths) && meta.cleanup_protective_worktree_paths.some((candidate) => typeof candidate === "string" && pathKey(candidate) === pathKey(value)) || handedOff && pathKey(handoff.worktree_path) === pathKey(value);
    if (matches) {
      const planId = typeof row.id === "string" ? row.id : typeof row.plan_id === "string" ? row.plan_id : undefined;
      claims.push({ workflowId: snapshot.id, ...planId ? { planId } : {} });
    }
  }
  return claims;
}
function cleanupOwner(claims) {
  const owners = new Map(claims.map((claim) => [JSON.stringify(claim), claim]));
  return owners.size === 1 ? [...owners.values()][0] : null;
}
async function cleanupWorktrees(input, invocation) {
  if (!input.workflow)
    throw new SddScriptError8("usage: worktree cleanup --workflow <id>", 2);
  if (input.workflow === "." || input.workflow === ".." || input.workflow.includes("/") || input.workflow.includes("\\"))
    throw new SddScriptError8(`invalid workflow id ${JSON.stringify(input.workflow)}`, 1);
  const main = readMainWorktree(invocation.cwd);
  if (!main)
    throw new Error("cannot resolve the main worktree of the current repository — run inside the repo");
  const harness = resolveProcessHarnessDir14(input.harness);
  if (!harness)
    throw new Error("harness directory not found");
  const root = resolveWorkflowDir4(harness, { harnessDir: harness });
  const selected = readWorkflowSnapshot3(path15.join(root, input.workflow)).snapshot;
  const snapshots = [selected];
  let unreadable = false;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === input.workflow)
      continue;
    const snapshotPath2 = path15.join(root, entry.name, WORKFLOW_SNAPSHOT_FILE3);
    if (!fs.existsSync(snapshotPath2))
      continue;
    try {
      snapshots.push(readWorkflowSnapshot3(path15.dirname(snapshotPath2)).snapshot);
    } catch {
      unreadable = true;
    }
  }
  const records = [];
  let current;
  for (const line of (await git(invocation, ["worktree", "list", "--porcelain"], main.root)).split(/\r?\n/)) {
    if (!line) {
      if (current)
        records.push({ ...current, isMain: records.length === 0, clean: await git(invocation, ["status", "--porcelain"], current.path) === "" });
      current = undefined;
    } else if (line.startsWith("worktree "))
      current = { path: line.slice(9), branch: null, tip: "", locked: false };
    else if (current && line.startsWith("HEAD "))
      current.tip = line.slice(5);
    else if (current && line.startsWith("branch "))
      current.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (current && line.startsWith("locked"))
      current.locked = true;
  }
  if (current)
    records.push({ ...current, isMain: records.length === 0, clean: await git(invocation, ["status", "--porcelain"], current.path) === "" });
  const claimsFor = (field, value) => snapshots.flatMap((snapshot) => cleanupClaims(snapshot, field, value));
  const targets = [];
  const pathKey = (value) => {
    try {
      return fs.realpathSync(value);
    } catch {
      return path15.resolve(value);
    }
  };
  const assertedPaths = new Set((input.worktree ?? []).map(pathKey));
  for (const wt of records) {
    if (assertedPaths.size && !assertedPaths.has(pathKey(wt.path)))
      continue;
    const claims = [...claimsFor("path", wt.path), ...wt.branch ? claimsFor("branch", wt.branch) : []];
    const inScope = input.allWorkflows || claims.some((claim) => claim.workflowId === input.workflow);
    if (inScope)
      targets.push({ kind: "worktree", ref: wt.path, branch: wt.branch ?? "", tip: wt.tip, owner: cleanupOwner(claims) });
  }
  const local = (await git(invocation, ["for-each-ref", "--format=%(refname:short)%09%(objectname)", "refs/heads"], main.root)).split(/\r?\n/).filter(Boolean);
  for (const line of local) {
    const [branch, tip] = line.split("\t");
    const claims = claimsFor("branch", branch);
    if ((input.allWorkflows || claims.some((claim) => claim.workflowId === input.workflow)) && (!assertedPaths.size || claims.some((claim) => targets.some((target) => target.kind === "worktree" && target.owner && JSON.stringify(target.owner) === JSON.stringify(claim))))) {
      targets.push({ kind: "local-branch", ref: branch, branch, tip: tip ?? "", owner: cleanupOwner(claims) });
    }
  }
  const remoteEvidence = [];
  if (input.remote) {
    const remoteRows = (await git(invocation, ["for-each-ref", "--format=%(refname:short)%09%(objectname)", "refs/remotes/origin"], main.root)).split(/\r?\n/).filter((line) => line && !line.startsWith("origin/HEAD"));
    for (const line of remoteRows) {
      const [fullName, tip] = line.split("\t");
      const branch = fullName.replace(/^origin\//, "");
      const claims = claimsFor("branch", branch);
      if (!(input.allWorkflows || claims.some((claim) => claim.workflowId === input.workflow)))
        continue;
      targets.push({ kind: "remote-branch", ref: fullName, branch, tip: tip ?? "", owner: cleanupOwner(claims) });
      const owner = cleanupOwner(claims);
      const ownerSnapshot = snapshots.find((snapshot) => snapshot.id === owner?.workflowId);
      const base = owner?.planId && ownerSnapshot?.type === "iteration" ? ownerSnapshot.branch?.integration : ownerSnapshot?.branch?.target;
      if (base) {
        const probe = await processReply(invocation, ["git", "merge-base", "--is-ancestor", tip ?? "", base], main.root);
        remoteEvidence.push({ branch, tip: tip ?? "", base, ancestor: probe.exitCode === 0, prMerged: null });
      }
    }
  }
  const defaultBranch = (await gitProbe(invocation, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], main.root)).replace(/^origin\//, "") || records[0]?.branch;
  if (!defaultBranch)
    throw new Error("cannot determine the default branch");
  const mergedLocalBranches = {};
  for (const snapshot of snapshots) {
    const base = snapshot.type === "iteration" ? snapshot.branch?.integration : snapshot.branch?.target;
    if (base) {
      const oid = await gitProbe(invocation, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`], main.root);
      if (oid)
        mergedLocalBranches[base] = (await gitProbe(invocation, ["branch", "--merged", oid, "--format=%(refname:short)"], main.root)).split(/\r?\n/).filter(Boolean);
    }
  }
  const facts = { targets, worktrees: records, snapshots, defaultBranch, mergedLocalBranches, remoteEvidence };
  const plan = planWorktreeCleanup(selected, facts).map((row) => unreadable && row.verdict === "remove" ? { ...row, verdict: "refuse", reason: "cleanup.refuse.unreadable-snapshot" } : row);
  if (!input.apply)
    return ok14("worktree.cleanup", { workflow: input.workflow, dryRun: true, decisions: plan });
  const evidenceBaseBranches = new Set(snapshots.flatMap((snapshot) => [snapshot.branch?.integration, snapshot.branch?.target]).filter((value) => Boolean(value)));
  const deferred = new Set(plan.filter((row) => row.kind === "worktree" && row.verdict === "remove" && records.some((wt) => wt.path === row.ref && wt.branch !== null && evidenceBaseBranches.has(wt.branch))).map(({ ref }) => ref));
  const removed = new Set;
  for (const row of plan)
    if (row.kind === "worktree" && row.verdict === "remove" && !deferred.has(row.ref) && !records.find((wt) => wt.path === row.ref)?.isMain) {
      await git(invocation, ["worktree", "remove", row.ref], main.root);
      removed.add(row.ref);
    }
  const refreshed = await cleanupWorktrees({ ...input, apply: false }, invocation);
  if (refreshed.status !== "ok")
    return refreshed;
  const secondPlan = refreshed.data.decisions;
  for (const row of secondPlan)
    if (row.kind === "local-branch" && row.verdict === "remove") {
      const target = targets.find((candidate) => candidate.kind === "local-branch" && candidate.ref === row.ref);
      const ownerSnapshot = snapshots.find((snapshot) => snapshot.id === target?.owner?.workflowId);
      const base = target?.owner?.planId && ownerSnapshot?.type === "iteration" ? ownerSnapshot.branch?.integration : ownerSnapshot?.branch?.target;
      const deletionCwd = records.find((wt) => wt.branch === base)?.path ?? main.root;
      await git(invocation, ["branch", "-d", row.ref], deletionCwd);
    }
  for (const row of secondPlan)
    if (row.kind === "worktree" && row.verdict === "remove" && deferred.has(row.ref)) {
      await git(invocation, ["worktree", "remove", row.ref], main.root);
      removed.add(row.ref);
    }
  for (const row of secondPlan)
    if (row.kind === "remote-branch" && row.verdict === "remove") {
      const target = targets.find((candidate) => candidate.kind === "remote-branch" && candidate.ref === row.ref);
      if (target)
        await git(invocation, ["push", `--force-with-lease=refs/heads/${target.branch}:${target.tip}`, "origin", `:refs/heads/${target.branch}`], main.root);
    }
  return ok14("worktree.cleanup", { workflow: input.workflow, dryRun: false, decisions: [...plan, ...secondPlan] });
}

// src/families/dashboard.ts
import { z as z18 } from "zod";
var id2 = "dashboard";
var inputSchema10 = z18.object({
  port: z18.coerce.number().int().min(0).max(65535).default(0),
  open: z18.boolean().optional(),
  project: z18.string().optional()
});
var dashboards = new WeakMap;
function failure7(code, error2) {
  return {
    version: 1,
    command: id2,
    status: "refused",
    code,
    exitCode: 1,
    message: error2 instanceof Error ? error2.message : String(error2)
  };
}
function serviceFor(context, harnessDir2, port, projectId) {
  let services = dashboards.get(context.effects);
  if (services === undefined) {
    services = new Map;
    dashboards.set(context.effects, services);
  }
  const key = JSON.stringify([harnessDir2, port]);
  const existing = services.get(key);
  if (existing !== undefined)
    return existing;
  const starting = context.effects.startDashboard({
    harnessDir: harnessDir2,
    port,
    ...projectId === undefined ? {} : { projectId }
  }).catch((error2) => {
    services.delete(key);
    throw error2;
  });
  services.set(key, starting);
  return starting;
}
async function execute12(input, context) {
  const parsed = inputSchema10.safeParse(input);
  if (!parsed.success) {
    return {
      version: 1,
      command: id2,
      status: "usage",
      code: "command.invalid-input",
      exitCode: 2,
      message: parsed.error.message
    };
  }
  const harnessDir2 = context.controlRoot;
  if (harnessDir2 === null) {
    return failure7("dashboard.harness-unavailable", new Error("no {HARNESS_DIR} found from the working directory"));
  }
  let server;
  try {
    server = await serviceFor(context, harnessDir2, parsed.data.port, parsed.data.project);
  } catch (error2) {
    const code = error2 !== null && typeof error2 === "object" && "code" in error2 && typeof error2.code === "string" ? error2.code : "dashboard.start-failed";
    return failure7(code, error2);
  }
  if (parsed.data.open === true) {
    try {
      await context.effects.openBrowser(server.url);
    } catch (error2) {
      const services = dashboards.get(context.effects);
      services?.delete(JSON.stringify([harnessDir2, parsed.data.port]));
      await server.close();
      return failure7("capability.browser.unavailable", error2);
    }
  }
  return {
    version: 1,
    command: id2,
    status: "ok",
    code: "dashboard.started",
    exitCode: 0,
    data: { url: server.url, lifetime: "connection" }
  };
}
function getDashboardCommandDefinitions() {
  return [{
    id: id2,
    cli: {
      path: ["dashboard"],
      aliases: [],
      arguments: [],
      options: [
        { key: "port", flags: "--port <port>", required: false, defaultValue: 0 },
        { key: "open", flags: "--open", required: false },
        { key: "project", flags: "--project <projectId>", required: false }
      ]
    },
    input: inputSchema10,
    output: commandEnvelopeSchema,
    effects: ["service", "browser"],
    description: "Start the read-only Morning Star dashboard on 127.0.0.1",
    execute: execute12
  }];
}

// src/families/local.ts
import { execFileSync as execFileSync2 } from "node:child_process";
import fs12 from "node:fs";
import os6 from "node:os";
import path25 from "node:path";
import {
  detectHarnessKind,
  detectHost,
  emitGitignoreSnippet,
  hasHarnessRootDeclaration as hasHarnessRootDeclaration2,
  resolveHarnessDir,
  resolveProjectDir,
  resolveScaffoldDirs,
  resolveSkillRoot,
  resolveSpecsDir,
  resolveWorkflowDir as resolveWorkflowDir5,
  scaffoldHarness,
  setArtifactStore as setArtifactStore8,
  createFsStore as createFsStore8
} from "@mstar-harness/engine";
import { z as z19 } from "zod";

// src/host-health/paths.ts
import fs2 from "node:fs";
import path16 from "node:path";
import { resolveProjectRoot as engineResolveProjectRoot } from "@mstar-harness/engine";
function resolveProjectRoot() {
  const candidate = process.env.MSTAR_CLI_PROJECT_ROOT || process.env.INIT_CWD || process.env.PWD;
  if (candidate && candidate.trim())
    return path16.resolve(candidate);
  return engineResolveProjectRoot();
}
function joinWithinRoot(root, ...segments) {
  const base = path16.resolve(root);
  const resolved = path16.resolve(base, ...segments);
  const withinRoot = resolved === base || resolved.startsWith(base + path16.sep) || base.endsWith(path16.sep) && resolved.startsWith(base);
  if (!withinRoot)
    throw new Error(`path escapes ${base}: ${segments.join(path16.sep)}`);
  return resolved;
}
function findUpPackageRoot(startDir, predicate) {
  let dir = path16.resolve(startDir);
  for (;; ) {
    try {
      const manifest = JSON.parse(fs2.readFileSync(joinWithinRoot(dir, "package.json"), "utf8"));
      if (predicate(manifest))
        return dir;
    } catch {}
    const parent = path16.dirname(dir);
    if (parent === dir)
      return null;
    dir = parent;
  }
}
function declaresWorkspaces(manifest) {
  return Array.isArray(manifest.workspaces) || typeof manifest.workspaces === "string" || manifest.workspaces !== undefined && manifest.workspaces !== null && typeof manifest.workspaces === "object";
}
function resolveCliProjectRoot() {
  const override = process.env.MSTAR_CLI_PROJECT_ROOT;
  if (override && override.trim())
    return path16.resolve(override);
  const monorepoRoot = findUpPackageRoot(process.cwd(), declaresWorkspaces);
  if (monorepoRoot)
    return monorepoRoot;
  const packageRoot = findUpPackageRoot(process.cwd(), () => true);
  if (packageRoot)
    return packageRoot;
  return process.cwd();
}
function resolveCliPath(userPath) {
  if (path16.isAbsolute(userPath))
    return userPath;
  const root = resolveCliProjectRoot();
  return root.endsWith(path16.sep) ? root + userPath : root + path16.sep + userPath;
}
// src/host-health/version-compare.ts
function splitVersion(v) {
  const dash = v.indexOf("-");
  if (dash === -1)
    return [v, undefined];
  return [v.slice(0, dash), v.slice(dash + 1)];
}
function compareCore(a, b) {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0;i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0)
      return d;
  }
  return 0;
}
function comparePrerelease(a, b) {
  if (a === undefined && b === undefined)
    return 0;
  if (a === undefined)
    return 1;
  if (b === undefined)
    return -1;
  const ia = a.split(".");
  const ib = b.split(".");
  const n = Math.min(ia.length, ib.length);
  for (let i = 0;i < n; i++) {
    const d = compareIdentifier(ia[i], ib[i]);
    if (d !== 0)
      return d;
  }
  return ia.length - ib.length;
}
function compareIdentifier(a, b) {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) {
    const na = BigInt(a);
    const nb = BigInt(b);
    return na < nb ? -1 : na > nb ? 1 : 0;
  }
  if (aNum)
    return -1;
  if (bNum)
    return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
function compareSemver(a, b) {
  const [coreA, preA] = splitVersion(a);
  const [coreB, preB] = splitVersion(b);
  const coreDiff = compareCore(coreA, coreB);
  if (coreDiff !== 0)
    return coreDiff;
  return comparePrerelease(preA, preB);
}
// src/host-health/plugin-version-alignment.ts
import fs3 from "node:fs";
import os from "node:os";
import path17 from "node:path";
var PLUGIN_VERSION_SHAPE_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
var PLUGIN_NAME = "morning-star-harness";
function highestVersion(current, candidate) {
  if (candidate === null)
    return current;
  if (current === null || compareSemver(candidate, current) > 0)
    return candidate;
  return current;
}
function versionFromJsonFile(filePath) {
  let raw;
  try {
    raw = fs3.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  try {
    const version = JSON.parse(raw).version;
    if (typeof version === "string" && PLUGIN_VERSION_SHAPE_RE.test(version.trim()))
      return version.trim();
  } catch {}
  return null;
}
function readTolerantVersion(dir, manifestRelPaths) {
  for (const rel of manifestRelPaths) {
    const version = versionFromJsonFile(path17.join(dir, rel));
    if (version !== null)
      return version;
  }
  return null;
}
function detectOpencodePluginVersion(packagesRoot = path17.join(os.homedir(), ".cache", "opencode", "packages")) {
  let specs;
  try {
    specs = fs3.readdirSync(path17.join(packagesRoot, "@mstar-harness"), { withFileTypes: true });
  } catch {
    return null;
  }
  let highest = null;
  for (const spec of specs) {
    if (!spec.isDirectory())
      continue;
    const pkgJson = path17.join(packagesRoot, "@mstar-harness", spec.name, "node_modules", "@mstar-harness", "opencode", "package.json");
    highest = highestVersion(highest, versionFromJsonFile(pkgJson));
  }
  return highest;
}
function detectCursorPluginVersion(pluginRoot) {
  return readTolerantVersion(pluginRoot, [".cursor-plugin/plugin.json", "package.json"]);
}
function detectCursorPluginVersionForScope(scope, paths) {
  if (scope !== "global") {
    const project = paths?.project ?? path17.join(resolveProjectRoot(), ".cursor", "plugins", "morning-star-harness");
    const projectVersion = detectCursorPluginVersion(project);
    if (projectVersion !== null)
      return projectVersion;
  }
  const global = paths?.global ?? path17.join(os.homedir(), ".cursor", "plugins", "local", "morning-star-harness");
  return detectCursorPluginVersion(global);
}
function detectZcodePluginVersion(cacheRoot = path17.join(os.homedir(), ".zcode", "cli", "plugins", "cache")) {
  let marketplaces;
  try {
    marketplaces = fs3.readdirSync(cacheRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  let highest = null;
  for (const marketplace of marketplaces) {
    if (!marketplace.isDirectory())
      continue;
    const pluginRoot = path17.join(cacheRoot, marketplace.name, PLUGIN_NAME);
    let versions;
    try {
      versions = fs3.readdirSync(pluginRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const version of versions) {
      if (!version.isDirectory())
        continue;
      const root = path17.join(pluginRoot, version.name);
      const candidate = readTolerantVersion(root, [".zcode-plugin/plugin.json", "plugin.json"]) ?? (PLUGIN_VERSION_SHAPE_RE.test(version.name) ? version.name : null);
      highest = highestVersion(highest, candidate);
    }
  }
  return highest;
}
function detectDshPluginVersion(dshHome = process.env.DSH_HOME ?? path17.join(os.homedir(), ".dsh")) {
  return versionFromJsonFile(path17.join(dshHome, "profiles", "web", "node_modules", "@mstar-harness", "dsh", "package.json"));
}
function ompEntryVersion(entry) {
  const direct = typeof entry.version === "string" ? entry.version.trim() : "";
  if (PLUGIN_VERSION_SHAPE_RE.test(direct))
    return direct;
  const manifest = entry.manifest && typeof entry.manifest === "object" ? entry.manifest : null;
  const manifestVersion = typeof manifest?.version === "string" ? manifest.version.trim() : "";
  if (PLUGIN_VERSION_SHAPE_RE.test(manifestVersion))
    return manifestVersion;
  const entryPath = typeof entry.path === "string" ? entry.path : "";
  if (!entryPath)
    return null;
  return versionFromJsonFile(path17.join(entryPath, "package.json"));
}
var PLUGIN_UPDATE_HINTS = {
  opencode: "update the Morning Star plugin (@mstar-harness/opencode) and restart OpenCode.",
  cursor: "update the Morning Star plugin checkout (git pull, or re-run mstar-harness init --target cursor).",
  codex: "update the Morning Star plugin: codex plugin marketplace upgrade, then codex plugin add morning-star-harness@mstar-repo.",
  zcode: "update the Morning Star plugin in ZCode (Settings → Plugin Management → update from the mstar-local marketplace).",
  omp: "update the Morning Star plugin: omp plugin install @mstar-harness/omp.",
  dsh: "update the Morning Star plugin: re-run mstar-harness init --target dsh (re-adds @mstar-harness/dsh in the web profile).",
  kimi: "update the Morning Star plugin via the Kimi TUI: /plugins install."
};
var NOT_INSTALLED_NOTES = {
  opencode: "No installed Morning Star plugin found under ~/.cache/opencode/packages/ (run mstar-harness init --target opencode to add @mstar-harness/opencode).",
  cursor: "No installed Morning Star plugin found under ~/.cursor/plugins/ (run mstar-harness init --target cursor).",
  codex: "No installed Morning Star plugin found in `codex plugin list` (install: codex plugin add morning-star-harness@mstar-repo).",
  zcode: "No installed Morning Star plugin found under ~/.zcode/cli/plugins/cache/ (install from the mstar-local marketplace).",
  omp: "No installed Morning Star plugin found in `omp plugin list` (install: omp plugin install @mstar-harness/omp).",
  dsh: "No installed Morning Star plugin found under ~/.dsh/profiles/ (run mstar-harness init --target dsh to add @mstar-harness/dsh).",
  kimi: "No installed Morning Star plugin found under $KIMI_CODE_HOME/plugins/managed (install via the Kimi TUI: /plugins install)."
};
function formatPluginVersionDoctorNote(target, cliVersion, installed) {
  if (installed === null)
    return NOT_INSTALLED_NOTES[target];
  const diff = compareSemver(cliVersion, installed);
  if (diff === 0)
    return `Plugin/CLI versions aligned (${installed}).`;
  if (diff > 0)
    return `CLI ${cliVersion} is newer than installed plugin ${installed} — ${PLUGIN_UPDATE_HINTS[target]}`;
  return `Installed plugin ${installed} is newer than CLI ${cliVersion} — update the global CLI: npm i -g @mstar-harness/cli@latest (or @${installed}).`;
}
// src/host-health/agent-plugins.ts
import fs4, { realpathSync } from "node:fs";
import path18 from "node:path";
import { readJson as readJson4 } from "@mstar-harness/engine";
var PLUGIN_SCHEMA_URL = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
var MCP_SCHEMA_URL = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
var PLUGIN_TOP_LEVEL_FIELDS = {
  $schema: true,
  name: true,
  version: true,
  description: true,
  author: true,
  homepage: true,
  repository: true,
  license: true,
  keywords: true,
  extensions: true
};
var PLUGIN_NAME_PATTERN = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
function stripMcpPathPrefix(raw) {
  if (raw.startsWith("./"))
    return raw.slice(2);
  if (raw.startsWith("${PLUGIN_ROOT}/"))
    return raw.slice("${PLUGIN_ROOT}/".length);
  if (raw.startsWith("${PLUGIN_DATA}/"))
    return raw.slice("${PLUGIN_DATA}/".length);
  if (raw === "${PLUGIN_ROOT}" || raw === "${PLUGIN_DATA}")
    return "";
  return null;
}
function escapesPluginRoot(remainder) {
  const normalized = path18.posix.normalize(remainder);
  return normalized.startsWith("..") || path18.posix.isAbsolute(normalized);
}
var SKILL_NAME_PATTERN = /^(?!.*--)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
var HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
var MCP_SERVER_TYPES = {
  stdio: true,
  "streamable-http": true,
  sse: true
};
var STDIO_FIELDS = { type: true, command: true, args: true, env: true, cwd: true };
var REMOTE_FIELDS = { type: true, url: true, headers: true };
var AUTHOR_FIELDS = { name: true, email: true, url: true };
function describeType(value) {
  if (value === null)
    return "null";
  if (Array.isArray(value))
    return "array";
  return typeof value;
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseScalar(raw) {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && (trimmed.startsWith('"') && trimmed.endsWith('"') || trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
function parseFrontmatter(filePath) {
  const content = fs4.readFileSync(filePath, "utf8");
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match)
    return null;
  const result = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!field)
      continue;
    result[field[1]] = parseScalar(field[2]);
  }
  return result;
}
function isValidMcpUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return false;
  if (!parsed.hostname)
    return false;
  if (parsed.username || parsed.password || parsed.hash)
    return false;
  const host = parsed.hostname;
  const isLoopback = host === "localhost" || host === "::1" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);
  if (!isLoopback && parsed.protocol !== "https:")
    return false;
  return true;
}
function validateManifest(manifest, errors, warnings) {
  if (!isPlainObject(manifest)) {
    errors.push("plugin.json: manifest must be a JSON object");
    return;
  }
  const doc = manifest;
  for (const key of Object.keys(doc)) {
    if (!Object.hasOwn(PLUGIN_TOP_LEVEL_FIELDS, key)) {
      warnings.push(`plugin.json: unknown top-level field "${key}" (ignored; client-specific data belongs under "extensions")`);
    }
  }
  const schema2 = doc["$schema"];
  if (typeof schema2 !== "string") {
    errors.push(`plugin.json: "$schema" is required and must be the string ${PLUGIN_SCHEMA_URL}`);
  } else if (schema2 !== PLUGIN_SCHEMA_URL) {
    errors.push(`plugin.json: unsupported "$schema" ${JSON.stringify(schema2)} (expected ${PLUGIN_SCHEMA_URL})`);
  }
  const name = doc.name;
  if (typeof name !== "string" || name.length === 0) {
    errors.push('plugin.json: "name" is required and must be a non-empty string');
  } else {
    if (name.length > 64) {
      errors.push(`plugin.json: "name" must be 1-64 characters (got ${name.length})`);
    }
    if (!PLUGIN_NAME_PATTERN.test(name)) {
      errors.push(`plugin.json: "name" ${JSON.stringify(name)} violates Agent Plugins name rules ` + `(lowercase alphanumerics, hyphens, periods; no "--" or ".."; must start and end alphanumeric)`);
    }
  }
  for (const field of ["version", "description", "homepage", "repository", "license"]) {
    const value = doc[field];
    if (value === undefined)
      continue;
    if (typeof value !== "string") {
      errors.push(`plugin.json: "${field}" must be a string (got ${describeType(value)})`);
    }
  }
  if (doc.author !== undefined) {
    if (!isPlainObject(doc.author)) {
      errors.push('plugin.json: "author" must be an object with optional string fields name/email/url');
    } else {
      const author = doc.author;
      for (const key of Object.keys(author)) {
        if (!Object.hasOwn(AUTHOR_FIELDS, key)) {
          errors.push(`plugin.json: "author" has unknown field "${key}" (only name, email, url are allowed)`);
        }
      }
      for (const key of ["name", "email", "url"]) {
        const value = author[key];
        if (value !== undefined && typeof value !== "string") {
          errors.push(`plugin.json: "author.${key}" must be a string (got ${describeType(value)})`);
        }
      }
    }
  }
  if (doc.keywords !== undefined) {
    if (!Array.isArray(doc.keywords) || doc.keywords.some((entry) => typeof entry !== "string")) {
      errors.push('plugin.json: "keywords" must be an array of strings');
    }
  }
  if (doc.extensions !== undefined) {
    if (!isPlainObject(doc.extensions)) {
      warnings.push('plugin.json: "extensions" is not an object — ignored');
    } else {
      for (const [namespace, value] of Object.entries(doc.extensions)) {
        if (!isPlainObject(value)) {
          warnings.push(`plugin.json: "extensions.${namespace}" is not an object — ignored`);
        }
      }
    }
  }
}
function validateMcpServer(name, entry, errors) {
  const prefix = `mcp.json: mcpServers.${name}`;
  if (!isPlainObject(entry)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  const server = entry;
  const type = server.type;
  if (typeof type !== "string" || !Object.hasOwn(MCP_SERVER_TYPES, type)) {
    errors.push(`${prefix}: "type" must be one of "stdio" | "streamable-http" | "sse" (got ${JSON.stringify(type)})`);
    return;
  }
  if (type === "stdio") {
    for (const key of Object.keys(server)) {
      if (!Object.hasOwn(STDIO_FIELDS, key)) {
        errors.push(`${prefix}: unknown field "${key}" for stdio server (allowed: type, command, args, env, cwd)`);
      }
    }
    const command6 = server.command;
    if (typeof command6 !== "string" || command6.length === 0) {
      errors.push(`${prefix}: "command" is required and must be a non-empty string`);
    } else {
      if (/\s/.test(command6)) {
        errors.push(`${prefix}: "command" must be a single executable token, not a shell command string`);
      } else if (command6.includes("/") && !command6.startsWith("./")) {
        errors.push(`${prefix}: "command" must be a bare executable name or a plugin-relative path beginning with "./"`);
      } else if (command6.startsWith("./") && escapesPluginRoot(command6.slice(2))) {
        errors.push(`${prefix}: "command" must remain within the plugin root (got "${command6}")`);
      }
    }
    if (server.args !== undefined) {
      if (!Array.isArray(server.args) || server.args.some((arg) => typeof arg !== "string")) {
        errors.push(`${prefix}: "args" must be an array of strings`);
      }
    }
    if (server.env !== undefined) {
      if (!isPlainObject(server.env)) {
        errors.push(`${prefix}: "env" must be an object of strings`);
      } else {
        for (const [key, value] of Object.entries(server.env)) {
          if (key === "PLUGIN_ROOT" || key === "PLUGIN_DATA") {
            errors.push(`${prefix}: "env" must not set reserved variable "${key}" (clients supply it themselves)`);
          }
          if (typeof value !== "string") {
            errors.push(`${prefix}: "env.${key}" must be a string`);
          }
        }
      }
    }
    if (server.cwd !== undefined) {
      if (typeof server.cwd !== "string") {
        errors.push(`${prefix}: "cwd" must be a string`);
      } else {
        const remainder = stripMcpPathPrefix(server.cwd);
        if (remainder === null) {
          errors.push(`${prefix}: "cwd" must be "./…", "${"${PLUGIN_ROOT}"}…", or "${"${PLUGIN_DATA}"}…"`);
        } else if (escapesPluginRoot(remainder)) {
          errors.push(`${prefix}: "cwd" must remain within the plugin root (got "${server.cwd}")`);
        }
      }
    }
    return;
  }
  for (const key of Object.keys(server)) {
    if (!Object.hasOwn(REMOTE_FIELDS, key)) {
      errors.push(`${prefix}: unknown field "${key}" for ${type} server (allowed: type, url, headers)`);
    }
  }
  const url = server.url;
  if (typeof url !== "string" || url.length === 0) {
    errors.push(`${prefix}: "url" is required and must be a non-empty string`);
  } else if (!isValidMcpUrl(url)) {
    errors.push(`${prefix}: "url" must be an absolute http(s) URL without user info or fragment; non-loopback endpoints must use https`);
  }
  if (server.headers !== undefined) {
    if (!isPlainObject(server.headers)) {
      errors.push(`${prefix}: "headers" must be an object of strings`);
    } else {
      const seen = new Set;
      for (const [key, value] of Object.entries(server.headers)) {
        if (typeof value !== "string") {
          errors.push(`${prefix}: "headers.${key}" must be a string`);
          continue;
        }
        if (value.includes("\r") || value.includes(`
`)) {
          errors.push(`${prefix}: "headers.${key}" value must be a single HTTP header value`);
        }
        if (!HTTP_HEADER_NAME_PATTERN.test(key)) {
          errors.push(`${prefix}: "headers.${key}" is not a valid HTTP header name`);
        } else {
          const lower = key.toLowerCase();
          if (seen.has(lower)) {
            errors.push(`${prefix}: header "${key}" is duplicated (case-insensitive)`);
          }
          seen.add(lower);
        }
      }
    }
  }
}
function validateMcp(root, manifestSchema, errors) {
  const mcpPath = `${root}${path18.sep}mcp.json`;
  if (!fs4.existsSync(mcpPath))
    return;
  let parsed;
  try {
    parsed = readJson4(mcpPath);
  } catch (error2) {
    errors.push(`mcp.json: ${error2.message}`);
    return;
  }
  if (!isPlainObject(parsed)) {
    errors.push("mcp.json: configuration must be a JSON object");
    return;
  }
  const doc = parsed;
  for (const key of Object.keys(doc)) {
    if (key !== "$schema" && key !== "mcpServers") {
      errors.push(`mcp.json: unknown top-level field "${key}" (only "$schema" and "mcpServers" allowed)`);
    }
  }
  const schema2 = doc["$schema"];
  if (typeof schema2 !== "string") {
    errors.push(`mcp.json: "$schema" is required and must be the string ${MCP_SCHEMA_URL}`);
  } else if (schema2 !== MCP_SCHEMA_URL) {
    errors.push(`mcp.json: unsupported "$schema" ${JSON.stringify(schema2)} (expected ${MCP_SCHEMA_URL})`);
  } else {
    const manifestVersion = typeof manifestSchema === "string" ? manifestSchema.match(/^https:\/\/agent-plugins\.org\/schemas\/([^/]+)\/plugin\.schema\.json$/)?.[1] : undefined;
    const mcpVersion = schema2.match(/^https:\/\/agent-plugins\.org\/schemas\/([^/]+)\/mcp\.schema\.json$/)?.[1];
    if (manifestVersion && mcpVersion && manifestVersion !== mcpVersion) {
      errors.push(`mcp.json: "$schema" targets Agent Plugins ${mcpVersion} but plugin.json targets ${manifestVersion} (versions must match)`);
    }
  }
  const servers = doc.mcpServers;
  if (!isPlainObject(servers)) {
    errors.push('mcp.json: "mcpServers" is required and must be an object');
    return;
  }
  for (const [serverName, entry] of Object.entries(servers)) {
    validateMcpServer(serverName, entry, errors);
  }
}
function validateSkills(root, errors, warnings) {
  const skillsPath = `${root}${path18.sep}skills`;
  try {
    if (!fs4.existsSync(skillsPath))
      return;
    if (!fs4.statSync(skillsPath).isDirectory()) {
      errors.push("skills: skills/ is not a directory (component type invalid)");
      return;
    }
    const entries = fs4.readdirSync(skillsPath, { withFileTypes: true });
    const realRoot = realpathSync(root);
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink())
        continue;
      const skillDir = entry.name;
      let realSkillPath;
      try {
        realSkillPath = realpathSync(`${skillsPath}${path18.sep}${skillDir}`);
      } catch (error2) {
        warnings.push(`skills: ${skillDir}/ cannot be resolved (${error2.message}; skill skipped)`);
        continue;
      }
      const insideRoot = realSkillPath === realRoot || realSkillPath.startsWith(realRoot + path18.sep) || realRoot.endsWith(path18.sep) && realSkillPath.startsWith(realRoot);
      if (!insideRoot) {
        warnings.push(`skills: ${skillDir}/ resolves outside the plugin root (${realSkillPath}; skill skipped)`);
        continue;
      }
      const skillMdPath = `${skillsPath}${path18.sep}${skillDir}${path18.sep}SKILL.md`;
      if (!fs4.existsSync(skillMdPath) || !fs4.statSync(skillMdPath).isFile()) {
        warnings.push(`skills: ${skillDir}/ has no SKILL.md (directory is not a skill; ignored)`);
        continue;
      }
      let realSkillMdPath;
      try {
        realSkillMdPath = realpathSync(skillMdPath);
      } catch (error2) {
        warnings.push(`skills: ${skillDir}/SKILL.md cannot be resolved (${error2.message}; skill skipped)`);
        continue;
      }
      const skillMdInsideRoot = realSkillMdPath.startsWith(realRoot + path18.sep) || realRoot.endsWith(path18.sep) && realSkillMdPath.startsWith(realRoot);
      if (!skillMdInsideRoot) {
        warnings.push(`skills: ${skillDir}/SKILL.md resolves outside the plugin root (${realSkillMdPath}; skill skipped)`);
        continue;
      }
      const frontmatter = parseFrontmatter(realSkillMdPath);
      if (!frontmatter) {
        warnings.push(`skills: ${skillDir}/SKILL.md is missing YAML frontmatter (name and description are required; skill skipped)`);
        continue;
      }
      const skillName = frontmatter.name;
      const problems = [];
      if (skillName !== skillDir) {
        problems.push(`frontmatter "name" ${JSON.stringify(skillName)} must equal the directory name "${skillDir}"`);
      } else if (!SKILL_NAME_PATTERN.test(skillName)) {
        problems.push(`frontmatter "name" violates Agent Skills name rules ` + `(lowercase alphanumerics and hyphens, no "--", no leading or trailing hyphen)`);
      }
      if (typeof skillName === "string" && skillName.length > 64) {
        problems.push(`frontmatter "name" must be at most 64 characters (got ${skillName.length})`);
      }
      const description = frontmatter.description;
      if (typeof description !== "string" || description.trim().length === 0) {
        problems.push(`frontmatter "description" is required and must be non-empty`);
      } else if (description.length > 1024) {
        problems.push(`frontmatter "description" must be at most 1024 characters (got ${description.length})`);
      }
      for (const problem of problems) {
        warnings.push(`skills: ${skillDir}/SKILL.md ${problem} (skill skipped)`);
      }
    }
  } catch (error2) {
    errors.push(`skills: ${error2.message}`);
  }
}
function validateAgentPlugin(root) {
  const errors = [];
  const warnings = [];
  if (!fs4.existsSync(root) || !fs4.statSync(root).isDirectory()) {
    errors.push(`plugin root: not a directory: ${root}`);
    return { ok: false, errors, warnings };
  }
  const manifestPath = `${root}${path18.sep}plugin.json`;
  if (!fs4.existsSync(manifestPath)) {
    errors.push(`plugin.json: manifest not found at ${manifestPath} (plugin root must contain plugin.json)`);
    return { ok: false, errors, warnings };
  }
  let manifest;
  try {
    manifest = readJson4(manifestPath);
  } catch (error2) {
    errors.push(`plugin.json: ${error2.message}`);
    return { ok: false, errors, warnings };
  }
  validateManifest(manifest, errors, warnings);
  const manifestSchema = isPlainObject(manifest) ? manifest["$schema"] : undefined;
  validateMcp(root, manifestSchema, errors);
  validateSkills(root, errors, warnings);
  return { ok: errors.length === 0, errors, warnings };
}
// src/host-health/codex.ts
import fs5 from "node:fs";
var PLUGIN_NAME2 = "morning-star-harness";
var CODEX_MARKETPLACE_NAME = "mstar-repo";
var MARKETPLACE_GIT_SOURCE = "btspoony/mstar-harness";
var CODEX_PLUGIN_ID = `${PLUGIN_NAME2}@${CODEX_MARKETPLACE_NAME}`;
function parseCodexMarketplaceNames(dump) {
  const parsed = JSON.parse(dump);
  const list = Array.isArray(parsed.marketplaces) ? parsed.marketplaces : [];
  return list.map((entry) => entry && typeof entry === "object" && ("name" in entry) && typeof entry.name === "string" ? entry.name : "").filter((name) => name !== "");
}
function parseCodexInstalledEntries(dump) {
  const parsed = JSON.parse(dump);
  const list = Array.isArray(parsed.installed) ? parsed.installed : [];
  return list.filter((entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry));
}
function parseCodexInstalledPluginIds(dump) {
  return parseCodexInstalledEntries(dump).map((entry) => typeof entry.pluginId === "string" ? entry.pluginId : "").filter((pluginId) => pluginId !== "");
}
function isCodexAvailable(probe) {
  try {
    probe();
    return true;
  } catch {
    return false;
  }
}
function detectCodexPluginVersion(runCodex) {
  let entries;
  try {
    entries = parseCodexInstalledEntries(runCodex(["plugin", "list", "--json"]));
  } catch {
    return null;
  }
  const entry = entries.find((candidate) => candidate.pluginId === CODEX_PLUGIN_ID);
  const version = typeof entry?.version === "string" ? entry.version : "";
  return version === "" ? null : version;
}
function legacyCodexMarketplaceNote(raw, legacyPath) {
  try {
    const parsed = JSON.parse(raw);
    const plugins = Array.isArray(parsed.plugins) ? parsed.plugins : [];
    const hasMstar = plugins.some((entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry) && ("name" in entry) && entry.name === PLUGIN_NAME2);
    if (hasMstar) {
      return `Legacy personal marketplace entry found at ${legacyPath} — the ${PLUGIN_NAME2} plugin now installs from the repo marketplace (${MARKETPLACE_GIT_SOURCE}). Remove the entry, then install: codex plugin add ${CODEX_PLUGIN_ID}`;
    }
  } catch {}
  return null;
}
var CODEX_BIN = "codex";
var CODEX_INSTALL_HINT = "Install the Codex CLI (https://github.com/openai/codex), e.g. `npm install -g @openai/codex`, then re-run init.";
function diagnoseCodexHost(runCodex, legacyMarketplacePath) {
  const errors = [];
  const notes = [];
  let legacyRaw;
  try {
    legacyRaw = fs5.readFileSync(legacyMarketplacePath, "utf8");
  } catch {
    legacyRaw = "";
  }
  const legacyNote = legacyCodexMarketplaceNote(legacyRaw, legacyMarketplacePath);
  if (legacyNote)
    notes.push(legacyNote);
  if (!isCodexAvailable(() => runCodex(["--version"]))) {
    errors.push(`${CODEX_BIN} CLI not found on PATH. ${CODEX_INSTALL_HINT}`);
    return { location: `${CODEX_BIN} marketplaces (config.toml)`, errors, notes };
  }
  try {
    const marketplaces = parseCodexMarketplaceNames(runCodex(["plugin", "marketplace", "list", "--json"]));
    if (!marketplaces.includes(CODEX_MARKETPLACE_NAME)) {
      errors.push(`Marketplace ${CODEX_MARKETPLACE_NAME} not configured (run init, or: ${CODEX_BIN} plugin marketplace add ${MARKETPLACE_GIT_SOURCE} --ref main).`);
    }
    const installed = parseCodexInstalledPluginIds(runCodex(["plugin", "list", "--json"]));
    if (marketplaces.includes(CODEX_MARKETPLACE_NAME) && !installed.includes(CODEX_PLUGIN_ID)) {
      notes.push(`Plugin not installed yet: ${CODEX_BIN} plugin add ${CODEX_PLUGIN_ID}`);
    }
  } catch (error2) {
    const message = error2 instanceof Error ? error2.message : String(error2);
    errors.push(`Could not query ${CODEX_BIN} plugin marketplace list: ${message}`);
  }
  return { location: `${CODEX_BIN} marketplaces (config.toml)`, errors, notes };
}
// src/host-health/cursor.ts
import fs6 from "node:fs";
import os2 from "node:os";
import path19 from "node:path";
var CURSOR_PLUGIN_NAME = "morning-star-harness";
var CURSOR_PLUGIN_MARKER = ".cursor-plugin/plugin.json";
var CURSOR_PLUGIN_LINK = ".cursor/plugins/morning-star-harness";
var CURSOR_AGENT_SMOKE_NAMES = ["fullstack-dev", "qc-specialist"];
function globalInstallPath(home = os2.homedir()) {
  return path19.join(home, ".cursor", "plugins", "local", CURSOR_PLUGIN_NAME);
}
function projectInstallPath(projectRoot = resolveProjectRoot()) {
  return path19.join(projectRoot, CURSOR_PLUGIN_LINK);
}
function validateGitCheckout(checkoutPath) {
  const errors = [];
  let stat;
  try {
    stat = fs6.lstatSync(checkoutPath);
  } catch {
    errors.push(`Missing checkout directory: ${checkoutPath}`);
    return errors;
  }
  if (stat.isSymbolicLink()) {
    errors.push(`Path must be a real directory, not a symlink: ${checkoutPath}. Run: mstar-harness init --target cursor`);
    return errors;
  }
  if (!fs6.existsSync(path19.join(checkoutPath, ".git"))) {
    errors.push(`Path is not a git checkout: ${checkoutPath}`);
  }
  const marker = path19.join(checkoutPath, CURSOR_PLUGIN_MARKER);
  if (!fs6.existsSync(marker))
    errors.push(`Missing marker file: ${marker}`);
  return errors;
}
function validatePluginAgents(pluginRoot) {
  const errors = [];
  const agentsDir = path19.join(pluginRoot, "agents");
  if (!fs6.existsSync(agentsDir)) {
    errors.push(`Missing plugin agents directory: ${agentsDir}`);
    return errors;
  }
  for (const agentName of CURSOR_AGENT_SMOKE_NAMES) {
    const agentPath = path19.join(agentsDir, `${agentName}.md`);
    if (!fs6.existsSync(agentPath)) {
      errors.push(`Missing plugin agent file: ${agentPath}`);
      continue;
    }
    const content = fs6.readFileSync(agentPath, "utf8");
    if (!/^---\nname:\s/m.test(content)) {
      errors.push(`Plugin agent ${agentName}.md must use Cursor-first frontmatter (name, description, model before OpenCode fields).`);
    }
  }
  return errors;
}
function diagnoseCursorHost(scope, roots) {
  const location = scope === "global" ? roots?.global ?? globalInstallPath() : roots?.project ?? projectInstallPath();
  return {
    location,
    errors: [...validateGitCheckout(location), ...validatePluginAgents(location)]
  };
}
// src/host-health/kimi.ts
import fs7 from "node:fs";
import os3 from "node:os";
import path20 from "node:path";
var PLUGIN_NAME3 = "morning-star-harness";
var PLUGIN_VERSION_SHAPE_RE2 = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
function kimiManagedRoot(kimiCodeHome = process.env.KIMI_CODE_HOME ?? path20.join(os3.homedir(), ".kimi-code")) {
  return path20.join(kimiCodeHome, "plugins", "managed");
}
function listDirsToDepth(root, maxDepth) {
  const out = [];
  const visit = (dir, depth) => {
    let entries;
    try {
      entries = fs7.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory())
        continue;
      const child = path20.join(dir, entry.name);
      out.push(child);
      if (depth + 1 < maxDepth)
        visit(child, depth + 1);
    }
  };
  visit(root, 0);
  return out;
}
function readPluginVersion(dir) {
  for (const manifest of [".kimi-plugin/plugin.json", "plugin.json", "package.json"]) {
    let raw;
    try {
      raw = fs7.readFileSync(path20.join(dir, manifest), "utf8");
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && "version" in parsed) {
        const version = parsed.version;
        if (typeof version === "string" && PLUGIN_VERSION_SHAPE_RE2.test(version.trim()))
          return version.trim();
      }
    } catch {
      continue;
    }
  }
  return null;
}
function detectKimiPluginVersion(kimiCodeHome = process.env.KIMI_CODE_HOME ?? path20.join(os3.homedir(), ".kimi-code")) {
  let highest = null;
  for (const dir of listDirsToDepth(kimiManagedRoot(kimiCodeHome), 3)) {
    if (path20.basename(dir) !== PLUGIN_NAME3)
      continue;
    const candidate = readPluginVersion(dir);
    if (candidate !== null && (highest === null || compareSemver(candidate, highest) > 0))
      highest = candidate;
  }
  return highest;
}
function diagnoseKimiHost(kimiCodeHome) {
  return { location: kimiManagedRoot(kimiCodeHome), errors: [], notes: [] };
}
// src/host-health/dsh.ts
import { DSH_LLM_FALLBACKS_VERSION } from "@mstar-harness/engine";
import fs8 from "node:fs";
import os4 from "node:os";
import path21 from "node:path";
var DSH_BIN = "dsh";
var DSH_PROFILE = "web";
var DSH_PROFILE_FLAG = "--profile";
var DSH_DUMP_FLAG = "--dump-config";
var DSH_HOME_ENV = "DSH_HOME";
var DSH_HOME_SUBDIR = ".dsh";
var DSH_PROFILES_DIR = "profiles";
var DSH_INSTALL_HINT = "Install the DeepSeek Harness CLI (@deepseek-ai/dsh), e.g. `pnpm add -g @deepseek-ai/dsh` or `npm install -g @deepseek-ai/dsh`, then re-run init.";
var DSH_PLUGIN_SPECS = ["@mstar-harness/dsh", `dsh-llm-fallbacks@${DSH_LLM_FALLBACKS_VERSION}`];
var DSH_FALLBACKS_SPEC = DSH_PLUGIN_SPECS[1];
function dshLoaderName(spec) {
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}
var DSH_FALLBACKS_LOADER_NAME = dshLoaderName(DSH_FALLBACKS_SPEC);
var FALLBACKS_VERSION_SHAPE_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
var DISABLED_MARKERS = /\b(?:disabled: true|enabled: false)\b/;
function resolveDshHome(dshHome) {
  if (dshHome !== undefined)
    return dshHome;
  return process.env[DSH_HOME_ENV] ?? path21.join(os4.homedir(), DSH_HOME_SUBDIR);
}
function resolveDshProfileDir(dshHome) {
  return path21.join(resolveDshHome(dshHome), DSH_PROFILES_DIR, DSH_PROFILE);
}
function readInstalledFallbacksVersion(profileDir) {
  const pkgJson = path21.join(profileDir, "node_modules", DSH_FALLBACKS_LOADER_NAME, "package.json");
  try {
    const raw = fs8.readFileSync(pkgJson, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !("version" in parsed) || typeof parsed.version !== "string") {
      return null;
    }
    const trimmed = parsed.version.trim();
    if (FALLBACKS_VERSION_SHAPE_RE.test(trimmed))
      return trimmed;
  } catch {}
  return null;
}
function fallbacksVersionDrifted(profileDir) {
  if (!FALLBACKS_VERSION_SHAPE_RE.test(DSH_LLM_FALLBACKS_VERSION))
    return false;
  const installedVersion = readInstalledFallbacksVersion(profileDir);
  if (installedVersion === null)
    return true;
  return compareSemver(installedVersion, DSH_LLM_FALLBACKS_VERSION) !== 0;
}
function isDshAvailable(probe) {
  try {
    probe();
    return true;
  } catch {
    return false;
  }
}
function parseDshLoaderEntries(dump) {
  const entries = [];
  let current = null;
  for (const line of dump.split(`
`)) {
    if (/^- id: /.test(line)) {
      if (current)
        entries.push(current);
      current = { name: "", enabled: !DISABLED_MARKERS.test(line) };
    } else if (current) {
      const nameMatch = /^  name: (.+)$/.exec(line);
      if (nameMatch) {
        let name = nameMatch[1].trim();
        if (DISABLED_MARKERS.test(line)) {
          current.enabled = false;
          name = name.replace(/\s*,?\s*(?:disabled: true|enabled: false)\s*$/, "");
        }
        current.name = name.replace(/^['"]|['"]$/g, "");
      } else if (/^  disabled: true$/.test(line) || /^  enabled: false$/.test(line)) {
        current.enabled = false;
      } else if (line.trim() !== "" && !line.startsWith("  ")) {
        entries.push(current);
        current = null;
      }
    }
  }
  if (current)
    entries.push(current);
  if (dump.trim() !== "" && (entries.length === 0 || entries.some((entry) => !entry.name))) {
    return null;
  }
  return entries;
}
function diagnoseDshHost(runDsh, roots) {
  const errors = [];
  const notes = [];
  const profileDir = resolveDshProfileDir(roots?.dshHome);
  if (!isDshAvailable(() => runDsh(["--version"]))) {
    errors.push(`${DSH_BIN} CLI not found on PATH. ${DSH_INSTALL_HINT}`);
    return { location: profileDir, errors, notes };
  }
  let dump;
  try {
    dump = runDsh([DSH_PROFILE_FLAG, DSH_PROFILE, DSH_DUMP_FLAG]);
  } catch (error2) {
    const message = error2 instanceof Error ? error2.message : String(error2);
    errors.push(`Warning: could not probe installed plugins (${message}); cannot verify install state.`);
    return { location: profileDir, errors, notes };
  }
  const entries = parseDshLoaderEntries(dump);
  if (entries === null) {
    errors.push("Warning: could not parse installed plugins from dump (unexpected format); cannot verify install state.");
    return { location: profileDir, errors, notes };
  }
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  for (const spec of DSH_PLUGIN_SPECS) {
    const entry = byName.get(spec) ?? byName.get(dshLoaderName(spec));
    const state = !entry ? "uninstalled" : entry.enabled ? "mounted" : "disabled";
    if (spec === DSH_FALLBACKS_SPEC && state === "mounted" && fallbacksVersionDrifted(profileDir)) {
      const installedVersion = readInstalledFallbacksVersion(profileDir);
      const installedLabel = installedVersion ?? "unknown";
      notes.push(`${spec}: drifted (installed ${installedLabel}, pinned ${DSH_LLM_FALLBACKS_VERSION})`);
      errors.push(`${spec} is drifted (profile has ${installedLabel}, harness pins ${DSH_LLM_FALLBACKS_VERSION}). Run: mstar-harness init --target dsh`);
      continue;
    }
    notes.push(`${spec}: ${state}`);
    if (state === "mounted")
      continue;
    const hint = state === "uninstalled" ? "Run: mstar-harness init --target dsh" : "Enable it (e.g. remove the disable entry from cordis.patch.yml) and re-run doctor.";
    errors.push(`${spec} is ${state}. ${hint}`);
  }
  return { location: profileDir, errors, notes };
}
// src/host-health/omp.ts
import fs9 from "node:fs";
import path22 from "node:path";
var PACKAGE_NAMES = {
  "morning-star": true,
  "morning-star-harness": true,
  "github:btspoony/mstar-harness": true,
  "@mstar-harness/omp": true
};
var SKILL_SMOKE = ["mstar-host", "mstar-harness-core", "pm"];
var COMMAND_SMOKE = ["iteration-start", "iteration-drive", "iteration-loop", "codebase-audit"];
function parseOmpPluginList(raw) {
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed))
    return parsed;
  if (parsed && typeof parsed === "object") {
    const record = parsed;
    if (Array.isArray(record.plugins))
      return record.plugins;
    const entries = [];
    for (const key of ["npm", "marketplace"]) {
      const group = record[key];
      if (Array.isArray(group)) {
        for (const item of group) {
          if (item && typeof item === "object")
            entries.push(item);
        }
      }
    }
    if (entries.length > 0)
      return entries;
  }
  return [];
}
function findInstalledPlugin(plugins) {
  return plugins.find((entry) => {
    const name = typeof entry.name === "string" ? entry.name : "";
    const pathValue = typeof entry.path === "string" ? entry.path : "";
    const manifest = entry.manifest && typeof entry.manifest === "object" ? entry.manifest : null;
    const manifestName = typeof manifest?.name === "string" ? manifest.name : "";
    if (Object.hasOwn(PACKAGE_NAMES, name) || Object.hasOwn(PACKAGE_NAMES, manifestName))
      return true;
    if (name.includes("morning-star") || manifestName.includes("morning-star"))
      return true;
    return pathValue.includes("mstar-harness") || pathValue.includes(`${path22.sep}morning-star`);
  });
}
function validatePluginTree(pluginRoot) {
  const errors = [];
  const markerPath = path22.join(pluginRoot, "plugin.json");
  if (!fs9.existsSync(markerPath))
    errors.push(`Missing omp plugin marker: ${markerPath}`);
  for (const skill of SKILL_SMOKE) {
    const skillPath = path22.join(pluginRoot, "skills", skill, "SKILL.md");
    if (!fs9.existsSync(skillPath))
      errors.push(`Missing skill: ${skillPath}`);
  }
  for (const command6 of COMMAND_SMOKE) {
    const commandPath = path22.join(pluginRoot, "commands", `${command6}.md`);
    if (!fs9.existsSync(commandPath))
      errors.push(`Missing command: ${commandPath}`);
  }
  const hostRef = path22.join(pluginRoot, "skills", "mstar-host", "references", "omp.md");
  if (!fs9.existsSync(hostRef))
    errors.push(`Missing omp host reference: ${hostRef}`);
  return errors;
}
function diagnoseOmpHost(input) {
  const errors = [...input.localHarnessRepoErrors];
  errors.push(...validatePluginTree(path22.join(input.harnessRepoPath, "packages", "omp")));
  if (!input.ompAvailable) {
    errors.push("omp CLI not found on PATH (required for omp target doctor checks).");
  } else {
    const installed = findInstalledPlugin(input.installedPlugins);
    if (!installed) {
      errors.push(`Morning Star plugin not found in \`omp plugin list\` (expected one of: ${Object.keys(PACKAGE_NAMES).join(", ")}). Run: mstar-harness init --target omp --scope ${input.scope}`);
    } else if (installed.enabled === false) {
      errors.push(`Morning Star omp plugin is installed but disabled (${String(installed.name)}).`);
    }
  }
  for (const entry of input.missingGitignoreEntries)
    errors.push(`Missing .gitignore entry: ${entry}`);
  return { location: input.harnessRepoPath, errors };
}
// src/host-health/opencode.ts
import fs10 from "node:fs";
import path23 from "node:path";
var OPENCODE_CONFIG_SCHEMA = "https://opencode.ai/config.json";
function isLegacyMorningStarGitPlugin(plugin) {
  const raw = plugin.trim();
  const match = /^morning-star@git\+(.+)$/i.exec(raw);
  if (!match)
    return false;
  const spec = match[1].split("#")[0].trim().toLowerCase();
  return /^https?:\/\/github\.com\/btspoony\/mstar-harness(\.git)?(\/.*)?$/.test(spec) || /^ssh:\/\/git@github\.com\/btspoony\/mstar-harness(\.git)?(\/.*)?$/.test(spec) || /^git@github\.com:btspoony\/mstar-harness(\.git)?$/.test(spec);
}
function isMstarHarnessOpencodePlugin(plugin) {
  const value = plugin.trim();
  return value === "@mstar-harness/opencode" || value.startsWith("@mstar-harness/opencode@");
}
function isAnyMstarHarnessOpencodeSlot(plugin) {
  return isLegacyMorningStarGitPlugin(plugin) || isMstarHarnessOpencodePlugin(plugin);
}
function validateOpencodeConfig(config) {
  const errors = [];
  if (config.$schema !== OPENCODE_CONFIG_SCHEMA) {
    errors.push(`Missing or invalid $schema (expected: ${OPENCODE_CONFIG_SCHEMA}).`);
  }
  const plugins = Array.isArray(config.plugin) ? config.plugin : [];
  const hasMstarOpencode = plugins.some((item) => typeof item === "string" && isAnyMstarHarnessOpencodeSlot(item.trim()));
  if (!hasMstarOpencode) {
    errors.push("Missing @mstar-harness/opencode plugin entry in `plugin` (or legacy morning-star git plugin).");
  }
  return errors;
}
function getOpencodeDoctorWarnings(config, allRoles) {
  const warnings = [];
  const plugins = Array.isArray(config.plugin) ? config.plugin : [];
  const strings = plugins.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  const hasNpm = strings.some(isMstarHarnessOpencodePlugin);
  const hasLegacy = strings.some(isLegacyMorningStarGitPlugin);
  if (hasLegacy && !hasNpm) {
    warnings.push("Plugin list uses legacy `morning-star@git+…` for this harness; run `mstar-harness init --target opencode` to rewrite to `@mstar-harness/opencode@latest`.");
  }
  if (hasLegacy && hasNpm) {
    warnings.push("Both legacy `morning-star@git+…` and `@mstar-harness/opencode` appear in `plugin`; run `init` again to dedupe and keep a single npm plugin line.");
  }
  const agent = config.agent && typeof config.agent === "object" && !Array.isArray(config.agent) ? config.agent : {};
  const missingModels = allRoles.filter((roleId) => {
    const role = agent[roleId] && typeof agent[roleId] === "object" && !Array.isArray(agent[roleId]) ? agent[roleId] : {};
    return typeof role.model !== "string" || !role.model.trim();
  });
  if (missingModels.length) {
    warnings.push(`${missingModels.length} role(s) have no explicit agent.<role>.model — OpenCode default model will be used (recommended for fastest setup).`);
  }
  return warnings;
}
function diagnoseOpencodeHost(root, allRoles) {
  const location = path23.join(root, "opencode.json");
  let config;
  try {
    const parsed = JSON.parse(fs10.readFileSync(location, "utf8"));
    config = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error2) {
    if (error2 && typeof error2 === "object" && "code" in error2 && error2.code === "ENOENT") {
      return { location, errors: [`Missing config file: ${location}`], warnings: [] };
    }
    const message = error2 instanceof Error ? error2.message : String(error2);
    return { location, errors: [`Could not read config file ${location}: ${message}`], warnings: [] };
  }
  const errors = validateOpencodeConfig(config);
  return {
    location,
    errors,
    warnings: errors.length ? [] : getOpencodeDoctorWarnings(config, allRoles)
  };
}
// src/host-health/zcode.ts
import fs11 from "node:fs";
import os5 from "node:os";
import path24 from "node:path";
import { hasHarnessRootDeclaration } from "@mstar-harness/engine";
var MARKETPLACE_ID = "mstar-local";
var MARKETPLACE_NAME = "mstar-local";
var GITHUB_REPO = "btspoony/mstar-harness";
var PLUGIN_NAME4 = "morning-star-harness";
var HARNESS_PROCESS_GITIGNORE = [
  ".mstar/**",
  "!.mstar/AGENTS.md",
  "!.mstar/knowledge/",
  "!.mstar/knowledge/**",
  "!.mstar/specs/",
  "!.mstar/specs/**",
  ".agents/**",
  "!.agents/AGENTS.md",
  "!.agents/knowledge/",
  "!.agents/knowledge/**",
  "!.agents/specs/",
  "!.agents/specs/**",
  ".mstarc"
];
var ZCODE_PLUGIN_MARKER = ".zcode-plugin/plugin.json";
var ZCODE_PLUGIN_CHECKOUT_PROJECT = ".zcode/plugin-checkout";
var ZCODE_AGENT_SMOKE_NAMES = ["fullstack-dev", "qc-specialist"];
var HARNESS_MARKERS = [".codex-plugin/plugin.json", ZCODE_PLUGIN_MARKER, ".omp-plugin/plugin.json"];
function ensureObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function readJson5(file) {
  return ensureObject(JSON.parse(fs11.readFileSync(file, "utf8")));
}
function findKnownMarketplace(raw) {
  const marketplaces = Array.isArray(raw.marketplaces) ? raw.marketplaces : [];
  return marketplaces.find((entry) => entry && typeof entry === "object" && !Array.isArray(entry) && entry.id === MARKETPLACE_ID);
}
function findMarketplacePlugin(raw) {
  const plugins = Array.isArray(raw.plugins) ? raw.plugins : [];
  return plugins.find((entry) => entry && typeof entry === "object" && !Array.isArray(entry) && entry.name === PLUGIN_NAME4);
}
function validateMarketplaceJson(file) {
  const errors = [];
  if (!fs11.existsSync(file)) {
    errors.push(`Missing ZCode marketplace: ${file}`);
    return errors;
  }
  const raw = readJson5(file);
  if (raw.name !== MARKETPLACE_NAME)
    errors.push(`ZCode marketplace name must be ${MARKETPLACE_NAME} (in ${file}).`);
  const entry = findMarketplacePlugin(raw);
  if (!entry) {
    errors.push(`Missing ${PLUGIN_NAME4} plugin entry in ${file}.`);
    return errors;
  }
  const source = ensureObject(entry.source);
  if (source.source !== "github")
    errors.push("ZCode marketplace plugin source.source must be `github`.");
  if (source.repo !== GITHUB_REPO)
    errors.push(`ZCode marketplace plugin source.repo must be ${GITHUB_REPO}.`);
  return errors;
}
function validateKnownMarketplaces(file) {
  const errors = [];
  if (!fs11.existsSync(file)) {
    errors.push(`Missing ZCode known_marketplaces.json: ${file}`);
    return errors;
  }
  const entry = findKnownMarketplace(readJson5(file));
  if (!entry) {
    errors.push(`Missing ${MARKETPLACE_ID} entry in ${file}.`);
    return errors;
  }
  if (entry.id !== MARKETPLACE_ID)
    errors.push(`known_marketplaces entry id must be ${MARKETPLACE_ID}.`);
  const source = ensureObject(entry.source);
  if (source.source !== "github")
    errors.push("known_marketplaces entry source.source must be github.");
  if (source.repo !== GITHUB_REPO)
    errors.push(`known_marketplaces entry source.repo must be ${GITHUB_REPO}.`);
  return errors;
}
function validatePluginAgents2(pluginRoot) {
  const errors = [];
  const agentsDir = path24.join(pluginRoot, "agents");
  if (!fs11.existsSync(agentsDir)) {
    errors.push(`Missing plugin agents directory: ${agentsDir}`);
    return errors;
  }
  for (const agentName of ZCODE_AGENT_SMOKE_NAMES) {
    const agentPath = path24.join(agentsDir, `${agentName}.md`);
    if (!fs11.existsSync(agentPath))
      errors.push(`Missing plugin agent file: ${agentPath}`);
  }
  return errors;
}
function validateLocalHarnessRepo(harnessRepoPath) {
  const errors = [];
  if (!fs11.existsSync(harnessRepoPath)) {
    errors.push(`Missing local harness repo: ${harnessRepoPath}`);
    return errors;
  }
  if (!HARNESS_MARKERS.some((marker) => fs11.existsSync(path24.join(harnessRepoPath, marker)))) {
    errors.push(`Local harness repo is missing a plugin marker (expected one of: ${HARNESS_MARKERS.join(", ")}).`);
  }
  return errors;
}
function validateGitCheckout2(checkoutPath) {
  const errors = [];
  let stat;
  try {
    stat = fs11.lstatSync(checkoutPath);
  } catch {
    errors.push(`Missing checkout directory: ${checkoutPath}`);
    return errors;
  }
  if (stat.isSymbolicLink()) {
    errors.push(`Path must be a real directory, not a symlink: ${checkoutPath}. Run: mstar-harness init --target cursor`);
    return errors;
  }
  if (!fs11.existsSync(path24.join(checkoutPath, ".git")))
    errors.push(`Path is not a git checkout: ${checkoutPath}`);
  const marker = path24.join(checkoutPath, ZCODE_PLUGIN_MARKER);
  if (!fs11.existsSync(marker))
    errors.push(`Missing marker file: ${marker}`);
  return errors;
}
function diagnoseZcodeHost(scope, roots = {}) {
  const pluginsRoot = roots.pluginsRoot ?? path24.join(os5.homedir(), ".zcode", "cli", "plugins");
  const projectRoot = roots.projectRoot ?? resolveProjectRoot();
  const harnessRepoPath = roots.harnessRepoPath ?? path24.join(os5.homedir(), ".mstar", "harness");
  const knownMarketplacesPath = path24.join(pluginsRoot, "known_marketplaces.json");
  const marketplacePath = path24.join(pluginsRoot, "marketplaces", MARKETPLACE_ID, "marketplace.json");
  const errors = validateLocalHarnessRepo(harnessRepoPath);
  if (scope === "project") {
    const checkoutPath = path24.join(projectRoot, ZCODE_PLUGIN_CHECKOUT_PROJECT);
    errors.push(...validateGitCheckout2(checkoutPath));
    const gitignorePath = path24.join(projectRoot, ".gitignore");
    const gitignore = fs11.existsSync(gitignorePath) ? fs11.readFileSync(gitignorePath, "utf8") : "";
    const lines = gitignore.split(/\r?\n/);
    if (!lines.includes(ZCODE_PLUGIN_CHECKOUT_PROJECT)) {
      errors.push(`Missing .gitignore entry: ${ZCODE_PLUGIN_CHECKOUT_PROJECT}`);
    }
    if (!hasHarnessRootDeclaration(gitignore)) {
      for (const entry of HARNESS_PROCESS_GITIGNORE) {
        if (!lines.includes(entry))
          errors.push(`Missing .gitignore entry: ${entry}`);
      }
    }
    errors.push(...validatePluginAgents2(checkoutPath));
  } else {
    errors.push(...validatePluginAgents2(harnessRepoPath));
  }
  errors.push(...validateKnownMarketplaces(knownMarketplacesPath));
  errors.push(...validateMarketplaceJson(marketplacePath));
  return { location: knownMarketplacesPath, errors };
}
// src/families/local.ts
var doctorTargets = ["opencode", "cursor", "codex", "zcode", "omp", "dsh", "kimi"];
var hostSignals = [
  "subagent_type",
  "question",
  "task_subagent",
  "task_agent_batch",
  "ask",
  "hub",
  "Agent",
  "AgentSwarm",
  "AskUserQuestion",
  "EnterPlanMode",
  "TodoWrite",
  "plan_slash",
  "goal",
  "functions.*",
  "tool_search"
];
var hostIds = ["opencode", "omp", "pi", "dsh", "cursor", "codex", "kimi", "zcode"];
var harnessRepoPath = path25.join(os6.homedir(), ".mstar", "harness");
var harnessMarkers = [".codex-plugin/plugin.json", ".zcode-plugin/plugin.json", ".omp-plugin/plugin.json"];
var agentsTemplate = `# AGENTS.md — .mstar/ (harness layer)

- Path symbols: {HARNESS_DIR} = .mstar/; {PLAN_DIR} = plans/; {SDD_DIR} = sdd/<plan-id>/;
  {ITERATION_DIR} = iterations/; {KNOWLEDGE_DIR} = knowledge/; {SPECS_DIR} = specs/;
  {WORKFLOW_DIR} = workflows/; {PROJECT_DIR} = projects/ (SSOT: skills/mstar-conventions).
- Process vs results: process artifacts (plans/, iterations/, sdd/, status.json, workflows/,
  projects/) stay local and gitignored; results (this file, knowledge/, specs/) are tracked
  and shared across clones.
- Done: only @project-manager or @qa-engineer may set Done; implementers set InReview.
`;
function ok15(id3, data) {
  return { version: 1, command: id3, status: "ok", code: `${id3}.ok`, exitCode: 0, data };
}
function refused10(id3, code, message, details) {
  return { version: 1, command: id3, status: "refused", code, exitCode: 1, message, ...details === undefined ? {} : { details } };
}
function usage8(id3, message) {
  return { version: 1, command: id3, status: "usage", code: "command.invalid-input", exitCode: 2, message };
}
function runBin(bin) {
  return (args) => {
    try {
      return execFileSync2(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error2) {
      const stdout = error2.stdout;
      if (typeof stdout === "string" && stdout !== "")
        return stdout;
      if (Buffer.isBuffer(stdout) && stdout.length > 0)
        return stdout.toString("utf8");
      throw error2;
    }
  };
}
function localHarnessErrors() {
  if (!fs12.existsSync(harnessRepoPath))
    return [`Missing local harness repo: ${harnessRepoPath}`];
  const marker = harnessMarkers.map((entry) => path25.join(harnessRepoPath, entry)).find((entry) => fs12.existsSync(entry));
  return marker === undefined ? [`Local harness repo is missing a plugin marker (expected one of: ${harnessMarkers.join(", ")}).`] : [];
}
function gitWorkspaceRoot(startDir) {
  try {
    const cdup = execFileSync2("git", ["rev-parse", "--show-cdup"], {
      cwd: startDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    if (!cdup)
      return startDir;
    let boundary = startDir;
    for (const segment of cdup.split(/[\\/]/)) {
      if (segment && segment !== ".")
        boundary = path25.dirname(boundary);
    }
    return boundary;
  } catch {
    return startDir;
  }
}
function pluginRoot(explicit) {
  if (explicit !== undefined)
    return path25.resolve(explicit);
  let candidate = resolveProjectRoot();
  while (!fs12.existsSync(path25.join(candidate, "plugin.json"))) {
    const parent = path25.dirname(candidate);
    if (parent === candidate)
      break;
    candidate = parent;
  }
  return candidate;
}
async function diagnose(target, scope) {
  if (target === "opencode") {
    const result2 = diagnoseOpencodeHost(resolveProjectRoot(), []);
    return { location: result2.location, errors: result2.errors, notes: result2.warnings };
  }
  if (target === "cursor") {
    const result2 = diagnoseCursorHost(scope);
    return { location: result2.location, errors: result2.errors, notes: [] };
  }
  if (target === "kimi")
    return diagnoseKimiHost();
  if (target === "zcode") {
    const result2 = diagnoseZcodeHost(scope, { projectRoot: resolveProjectRoot(), harnessRepoPath });
    return { location: result2.location, errors: result2.errors, notes: [] };
  }
  if (target === "codex") {
    const result2 = diagnoseCodexHost(runBin("codex"), path25.join(os6.homedir(), ".agents", "plugins", "marketplace.json"));
    return { location: result2.location, errors: [...localHarnessErrors(), ...result2.errors], notes: result2.notes };
  }
  if (target === "dsh")
    return diagnoseDshHost(runBin("dsh"));
  const projectRoot = scope === "project" ? resolveProjectRoot() : undefined;
  const gitignorePath = projectRoot === undefined ? undefined : path25.join(projectRoot, ".gitignore");
  const gitignore = gitignorePath !== undefined && fs12.existsSync(gitignorePath) ? fs12.readFileSync(gitignorePath, "utf8") : "";
  let installed = [];
  let ompAvailable = true;
  try {
    installed = parseOmpPluginList(runBin("omp")(["plugin", "list", "--json"]));
  } catch {
    ompAvailable = false;
  }
  const present = new Set(gitignore.split(/\r?\n/));
  const missing = projectRoot === undefined || hasHarnessRootDeclaration2(gitignore) ? [] : emitGitignoreSnippet("mstar").split(`
`).map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#") && !present.has(line));
  const result = diagnoseOmpHost({
    harnessRepoPath,
    scope,
    ompAvailable,
    installedPlugins: installed,
    localHarnessRepoErrors: localHarnessErrors(),
    missingGitignoreEntries: missing
  });
  return { location: result.location, errors: result.errors, notes: [] };
}
function command6(id3, definition2) {
  return { id: id3, output: commandEnvelopeSchema, ...definition2 };
}
function getLocalCommandDefinitions() {
  return [
    command6("harness.scaffold", {
      cli: { path: ["harness", "scaffold"], aliases: [], arguments: [{ key: "path", required: false, variadic: false }], options: [] },
      input: z19.object({ path: z19.string().min(1).optional() }),
      effects: ["write"],
      description: "Create the harness directory, v2 status, default project, and the canonical ignore/AGENTS files when absent.",
      async execute(input) {
        const root = input.path === undefined ? process.cwd() : path25.resolve(input.path);
        setArtifactStore8(createFsStore8(resolveScaffoldDirs(root).harnessDir));
        const harnessDir2 = await scaffoldHarness(root);
        const projectDir = resolveProjectDir(root, { harnessDir: harnessDir2 });
        const created = [];
        const skipped = [];
        const workspaceRoot = gitWorkspaceRoot(root);
        const defaultHarness = path25.join(workspaceRoot, ".mstar");
        if (detectHarnessKind(harnessDir2) === "mstar" && path25.resolve(harnessDir2) === defaultHarness) {
          const gitignorePath = path25.join(workspaceRoot, ".gitignore");
          const current = fs12.existsSync(gitignorePath) ? fs12.readFileSync(gitignorePath, "utf8") : "";
          if (hasHarnessRootDeclaration2(current))
            skipped.push(".gitignore (author-owned harness-root declaration)");
          else {
            const lines = new Set(current.split(/\r?\n/).map((line) => line.trim()));
            const snippetLines = emitGitignoreSnippet("mstar").split(`
`).map((line) => line.trim());
            const missing = snippetLines.filter((line) => line !== "" && !lines.has(line));
            if (missing.length > 0) {
              const prefix = current !== "" && !current.endsWith(`
`) ? `
` : "";
              fs12.appendFileSync(gitignorePath, `${prefix}${missing.join(`
`)}
`, "utf8");
              created.push(".gitignore (canonical harness snippet)");
            } else
              skipped.push(".gitignore (canonical harness snippet already present)");
          }
        } else
          skipped.push(".gitignore (canonical harness snippet) — custom harness layout manages its own ignore rules");
        const agentsPath = path25.join(harnessDir2, "AGENTS.md");
        if (!fs12.existsSync(agentsPath)) {
          fs12.writeFileSync(agentsPath, agentsTemplate, "utf8");
          created.push(`${path25.basename(harnessDir2)}/AGENTS.md`);
        } else
          skipped.push(`${path25.basename(harnessDir2)}/AGENTS.md (already present)`);
        return ok15("harness.scaffold", { harnessDir: harnessDir2, projectDir, created, skipped });
      }
    }),
    command6("doctor", {
      cli: {
        path: ["doctor"],
        aliases: [],
        arguments: [],
        options: [
          { key: "target", flags: "--target <target>", required: false, defaultValue: "opencode" },
          { key: "scope", flags: "--scope <scope>", required: false, defaultValue: "project" },
          { key: "output", flags: "--output <path>", required: false }
        ]
      },
      input: z19.object({
        target: z19.enum(doctorTargets).default("opencode"),
        scope: z19.enum(["global", "project"]).default("project"),
        output: z19.string().optional()
      }),
      effects: ["read"],
      description: "Validate Morning Star setup for one supported host target.",
      async execute(input, context) {
        const result = await diagnose(input.target, input.scope);
        const data = {
          ...result,
          target: input.target,
          scope: input.scope,
          pluginVersionNote: formatPluginVersionDoctorNote(input.target, context.versions.cli ?? "unknown", null),
          ...input.output === undefined ? {} : { output: input.output }
        };
        return result.errors.length === 0 ? ok15("doctor", data) : refused10("doctor", "doctor.unhealthy", `${result.errors.length} issue(s)`, data);
      }
    }),
    command6("plugin.validate", {
      cli: { path: ["plugin", "validate"], aliases: [], arguments: [], options: [{ key: "root", flags: "--root <path>", required: false }] },
      input: z19.object({ root: z19.string().optional() }),
      effects: ["validate"],
      description: "Validate a plugin package against Agent Plugins v1.0.0.",
      async execute(input) {
        const root = pluginRoot(input.root);
        const result = validateAgentPlugin(root);
        return result.ok ? ok15("plugin.validate", { root, ...result }) : refused10("plugin.validate", "plugin.invalid", result.errors.join(`
`), { root, ...result });
      }
    }),
    command6("path.resolve", {
      cli: { path: ["path", "resolve"], aliases: [], arguments: [{ key: "path", required: false, variadic: false }], options: [] },
      input: z19.object({ path: z19.string().min(1).optional() }),
      effects: ["read"],
      description: "Resolve harness, specs, workflow, and project directories from a start directory.",
      async execute(input, context) {
        const startDir = input.path === undefined ? context.cwd : path25.resolve(context.cwd, input.path);
        const harnessDir2 = resolveHarnessDir(startDir);
        if (harnessDir2 === null) {
          return refused10("path.resolve", "path.harness-not-found", `no harness dir found from ${startDir}`, {
            startDir,
            harnessDir: null,
            specsDir: null,
            workflowDir: null,
            projectDir: null
          });
        }
        return ok15("path.resolve", {
          startDir,
          harnessDir: harnessDir2,
          specsDir: resolveSpecsDir(harnessDir2, { create: false }),
          workflowDir: resolveWorkflowDir5(startDir),
          projectDir: resolveProjectDir(startDir)
        });
      }
    }),
    command6("host.detect", {
      cli: { path: ["host", "detect"], aliases: [], arguments: [], options: [{ key: "signals", flags: "--signals <list>", required: true }] },
      input: z19.object({ signals: z19.string().min(1) }),
      effects: ["read"],
      description: "Detect the active host from comma-separated tool-shape signals.",
      async execute(input) {
        const signals = input.signals.split(",").map((signal) => signal.trim()).filter((signal) => signal !== "");
        if (signals.length === 0)
          return usage8("host.detect", "usage: host detect --signals <comma-list>");
        const unknown = signals.find((signal) => !hostSignals.includes(signal));
        if (unknown !== undefined)
          return usage8("host.detect", `unknown signal ${JSON.stringify(unknown)}`);
        return ok15("host.detect", { host: detectHost(signals) });
      }
    }),
    command6("host.skill-root", {
      cli: {
        path: ["host", "skill-root"],
        aliases: [],
        arguments: [],
        options: [
          { key: "host", flags: "--host <id>", required: true },
          { key: "skill", flags: "--skill <name>", required: true },
          { key: "rel", flags: "--rel <path>", required: false }
        ]
      },
      input: z19.object({ host: z19.string().min(1), skill: z19.string().min(1), rel: z19.string().optional() }),
      effects: ["read"],
      description: "Resolve the loaded skill root for a host.",
      async execute(input) {
        if (!hostIds.includes(input.host))
          return usage8("host.skill-root", `unknown host ${JSON.stringify(input.host)}`);
        return ok15("host.skill-root", { root: resolveSkillRoot(input.host, { skill: input.skill, rel: input.rel }) });
      }
    })
  ];
}

// src/families/schema.ts
import { ISSUE_PAYLOAD_SCHEMAS } from "@mstar-harness/engine";
import { z as z20 } from "zod";
function getPayloadSchema(typeName) {
  if (!Object.hasOwn(ISSUE_PAYLOAD_SCHEMAS, typeName)) {
    throw new RangeError(`Unknown payload type: ${typeName}`);
  }
  const fields = ISSUE_PAYLOAD_SCHEMAS[typeName];
  return {
    type: typeName,
    fields: Object.entries(fields).map(([name, field]) => ({ name, ...field }))
  };
}
function getCommandSchemas(definitions2) {
  return definitions2.map((definition2) => ({
    id: definition2.id,
    cli: definition2.cli,
    input: definition2.input.toJSONSchema(),
    payloadSchemas: ISSUE_PAYLOAD_SCHEMAS
  }));
}
function getSchemaCommandDefinitions() {
  const id3 = "schema";
  const definition2 = {
    id: id3,
    cli: { path: ["schema"], aliases: [], arguments: [{ key: "type", required: true, variadic: false }], options: [] },
    input: z20.object({ type: z20.string().min(1) }),
    output: commandEnvelopeSchema,
    effects: ["read"],
    description: "Print the runtime field schema for one JSON payload type.",
    async execute(input) {
      if (!Object.hasOwn(ISSUE_PAYLOAD_SCHEMAS, input.type)) {
        return {
          version: 1,
          command: id3,
          status: "usage",
          code: "command.invalid-input",
          exitCode: 2,
          message: `unknown payload type ${JSON.stringify(input.type)}; available: ${Object.keys(ISSUE_PAYLOAD_SCHEMAS).join(", ")}`
        };
      }
      return { version: 1, command: id3, status: "ok", code: "schema.ok", exitCode: 0, data: getPayloadSchema(input.type) };
    }
  };
  return [definition2];
}

// src/definitions.ts
var failureEnvelopeSchema = z21.object({
  version: z21.literal(1),
  command: z21.string().min(1),
  status: z21.enum(["refused", "error"]),
  code: z21.string().min(1),
  exitCode: z21.number().int().refine((code) => code !== 0),
  message: z21.string(),
  details: z21.record(z21.string(), z21.unknown()).optional()
});
var commandEnvelopeSchema = z21.discriminatedUnion("status", [
  z21.object({
    version: z21.literal(1),
    command: z21.string().min(1),
    status: z21.literal("ok"),
    code: z21.string().min(1),
    exitCode: z21.literal(0),
    data: z21.unknown()
  }),
  failureEnvelopeSchema,
  z21.object({
    version: z21.literal(1),
    command: z21.string().min(1),
    status: z21.literal("usage"),
    code: z21.string().min(1),
    exitCode: z21.literal(2),
    message: z21.string(),
    details: z21.record(z21.string(), z21.unknown()).optional()
  })
]);

class CommandDefinitionError extends Error {
  constructor(message) {
    super(message);
    this.name = "CommandDefinitionError";
  }
}
function validateOne(definition2) {
  if (!definition2.id || definition2.id.trim() !== definition2.id) {
    throw new CommandDefinitionError("Command id must be a non-empty trimmed string");
  }
  if (definition2.cli.path.length === 0 || definition2.cli.path.some((part) => part.trim() === "")) {
    throw new CommandDefinitionError(`${definition2.id}: CLI path must contain non-empty segments`);
  }
  if (definition2.cli.arguments.some((argument) => argument.key.trim() === "")) {
    throw new CommandDefinitionError(`${definition2.id}: CLI argument keys must be non-empty`);
  }
  if (definition2.cli.options.some((option) => option.key.trim() === "" || option.flags.trim() === "")) {
    throw new CommandDefinitionError(`${definition2.id}: CLI options require keys and flags`);
  }
  const syntaxKeys = [
    ...definition2.cli.arguments.map(({ key }) => key),
    ...definition2.cli.options.filter(({ context }) => context === undefined).map(({ key }) => key)
  ].sort();
  const contextKeys = definition2.cli.options.filter(({ context }) => context !== undefined);
  if (contextKeys.some(({ context }) => context !== "sessionId")) {
    throw new CommandDefinitionError(`${definition2.id}: CLI context options must name a supported invocation context`);
  }
  const allSyntaxKeys = {};
  for (const key of [...syntaxKeys, ...contextKeys.map(({ key: key2 }) => key2)]) {
    if (allSyntaxKeys[key] === true) {
      throw new CommandDefinitionError(`${definition2.id}: CLI syntax contains duplicate input or context keys`);
    }
    allSyntaxKeys[key] = true;
  }
  if (definition2.input instanceof z21.ZodObject) {
    const schemaKeys = Object.keys(definition2.input.shape).sort();
    if (schemaKeys.length !== syntaxKeys.length || schemaKeys.some((key, index) => key !== syntaxKeys[index])) {
      throw new CommandDefinitionError(`${definition2.id}: CLI syntax keys must match input schema keys`);
    }
  }
  if (!definition2.output.safeParse({
    version: 1,
    command: definition2.id,
    status: "ok",
    code: "command.ok",
    exitCode: 0,
    data: null
  }).success) {
    throw new CommandDefinitionError(`${definition2.id}: output schema must accept a valid success envelope`);
  }
}
function validateCommandDefinitions(definitions2) {
  const ids = new Set;
  const cliSpellings = new Set;
  const toolNames = new Set;
  for (const definition2 of definitions2) {
    validateOne(definition2);
    if (ids.has(definition2.id))
      throw new CommandDefinitionError(`Duplicate command id: ${definition2.id}`);
    ids.add(definition2.id);
    const spellings = [definition2.cli.path.join("."), ...definition2.cli.aliases];
    for (const spelling of spellings) {
      if (cliSpellings.has(spelling))
        throw new CommandDefinitionError(`Duplicate CLI spelling: ${spelling}`);
      cliSpellings.add(spelling);
    }
    const toolName = `mstar_${definition2.id.replace(/[.-]/g, "_")}`;
    if (toolNames.has(toolName))
      throw new CommandDefinitionError(`Duplicate MCP tool name: ${toolName}`);
    toolNames.add(toolName);
  }
}
var canonicalDefinitions = [
  ...getStatusCommandDefinitions(),
  ...getPersistCommandDefinitions(),
  ...getCoordinationChecksCommandDefinitions(),
  ...getPlanCommandDefinitions(),
  ...getSessionCommandDefinitions(),
  ...getWorkflowCommandDefinitions(),
  ...getIssueCommandDefinitions(),
  ...getCatalogCommandDefinitions(),
  ...getRoadmapCommandDefinitions(),
  ...getStoreCommandDefinitions(),
  ...getExecutionCommandDefinitions(),
  ...getSddCommandDefinitions(),
  ...getAuditCommandDefinitions(),
  ...getValidationCommandDefinitions(),
  ...getPrReviewCommandDefinitions(),
  ...getProcessCommandDefinitions(),
  ...getJudgmentCommandDefinitions(),
  ...getDashboardCommandDefinitions(),
  ...getLocalCommandDefinitions(),
  ...getSchemaCommandDefinitions()
];
validateCommandDefinitions(canonicalDefinitions);
function getCommandDefinitions() {
  return canonicalDefinitions;
}
async function executeCommand(id3, input, context) {
  const definition2 = canonicalDefinitions.find((entry) => entry.id === id3);
  if (definition2 === undefined) {
    return { version: 1, command: id3, status: "error", code: "command.unknown", exitCode: 1, message: `unknown command: ${id3}` };
  }
  const parsed = definition2.input.safeParse(input);
  if (!parsed.success) {
    return {
      version: 1,
      command: id3,
      status: "usage",
      code: "command.invalid-input",
      exitCode: 2,
      message: parsed.error.issues.map((issue) => issue.message).join("; ")
    };
  }
  const sessionKey = definition2.cli.options.find((option) => option.context === "sessionId")?.key;
  const sessionValue = sessionKey === undefined || parsed.data === null || typeof parsed.data !== "object" ? undefined : Object.entries(parsed.data).find(([key]) => key === sessionKey)?.[1];
  const request = typeof sessionValue === "string" ? { ...context, sessionId: sessionValue } : context;
  try {
    const envelope2 = await definition2.execute(parsed.data, request);
    if (!definition2.output.safeParse(envelope2).success) {
      return { version: 1, command: id3, status: "error", code: "command.output-invalid", exitCode: 1, message: "handler returned an invalid envelope" };
    }
    return envelope2;
  } catch (error2) {
    if (request.signal.aborted) {
      return { version: 1, command: id3, status: "error", code: "command.cancelled", exitCode: 1, message: "cancelled" };
    }
    return { version: 1, command: id3, status: "error", code: "command.internal", exitCode: 1, message: error2 instanceof Error ? error2.message : String(error2) };
  }
}
// src/effects/process.ts
import { constants as constants2 } from "node:os";
import { spawn as nodeSpawn } from "node:child_process";
function spawnProcess(request) {
  if (request.signal.aborted) {
    return Promise.reject(Object.assign(new Error("process admission cancelled"), { code: "command.cancelled" }));
  }
  if (request.argv.length === 0) {
    return Promise.reject(new TypeError("process argv must include an executable"));
  }
  const { promise, resolve: resolve2, reject } = Promise.withResolvers();
  let child;
  let settled = false;
  let abortTimer;
  const cleanup = () => {
    request.signal.removeEventListener("abort", abort);
    if (abortTimer !== undefined)
      clearTimeout(abortTimer);
  };
  const finish = (result) => {
    if (settled)
      return;
    settled = true;
    cleanup();
    resolve2(result);
  };
  const abort = () => {
    if (child === undefined || child.pid === undefined)
      return;
    child.kill("SIGTERM");
    abortTimer = setTimeout(() => child?.kill("SIGKILL"), 2000);
    abortTimer.unref();
  };
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    child = nodeSpawn(request.argv[0], request.argv.slice(1), {
      cwd: request.cwd,
      env: { ...request.env },
      shell: false,
      stdio: [request.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"]
    });
  } catch (error2) {
    cleanup();
    reject(error2);
    return promise;
  }
  if (request.signal.aborted)
    abort();
  const stdout = [];
  const stderr = [];
  child.stdout?.on("data", (chunk) => stdout.push(chunk));
  child.stderr?.on("data", (chunk) => stderr.push(chunk));
  child.once("error", (error2) => {
    cleanup();
    settled = true;
    if (error2.code === "ENOENT") {
      reject(Object.assign(error2, { code: "process.not-found", exitCode: 127 }));
    } else
      reject(error2);
  });
  child.once("close", (exitCode, signal) => finish({
    exitCode: exitCode ?? (signal ? 128 + (constants2.signals[signal] ?? 0) : 1),
    signal,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8")
  }));
  if (request.stdin !== undefined)
    child.stdin?.end(request.stdin);
  return promise;
}
export {
  CODEX_MARKETPLACE_NAME,
  CommandDefinitionError,
  DASHBOARD_CSP,
  DSH_BIN,
  DSH_DUMP_FLAG,
  DSH_FALLBACKS_LOADER_NAME,
  DSH_FALLBACKS_SPEC,
  DSH_HOME_ENV,
  DSH_HOME_SUBDIR,
  DSH_INSTALL_HINT,
  DSH_PLUGIN_SPECS,
  DSH_PROFILE,
  DSH_PROFILES_DIR,
  DSH_PROFILE_FLAG,
  OPENCODE_CONFIG_SCHEMA,
  PLAN_COORDINATOR_TRANSITIONS,
  PLUGIN_VERSION_SHAPE_RE,
  commandEnvelopeSchema,
  compareSemver,
  detectCodexPluginVersion,
  detectCursorPluginVersion,
  detectCursorPluginVersionForScope,
  detectDshPluginVersion,
  detectKimiPluginVersion,
  detectOpencodePluginVersion,
  detectZcodePluginVersion,
  diagnoseCodexHost,
  diagnoseCursorHost,
  diagnoseDshHost,
  diagnoseKimiHost,
  diagnoseOmpHost,
  diagnoseOpencodeHost,
  diagnoseZcodeHost,
  dshLoaderName,
  executeCommand,
  fallbacksVersionDrifted,
  findInstalledPlugin,
  formatPluginVersionDoctorNote,
  getAuditCommandDefinitions,
  getCatalogCommandDefinitions,
  getCommandDefinitions,
  getCommandSchemas,
  getDashboardCommandDefinitions,
  getExecutionCommandDefinitions,
  getIssueCommandDefinitions,
  getJudgmentCommandDefinitions,
  getLocalCommandDefinitions,
  getOpencodeDoctorWarnings,
  getPayloadSchema,
  getPlanCommandDefinitions,
  getPrReviewCommandDefinitions,
  getProcessCommandDefinitions,
  getRoadmapCommandDefinitions,
  getSchemaCommandDefinitions,
  getSddCommandDefinitions,
  getSessionCommandDefinitions,
  getStoreCommandDefinitions,
  getValidationCommandDefinitions,
  getWorkflowCommandDefinitions,
  globalInstallPath,
  isAnyMstarHarnessOpencodeSlot,
  isCodexAvailable,
  isDshAvailable,
  isLegacyMorningStarGitPlugin,
  isMstarHarnessOpencodePlugin,
  joinWithinRoot,
  kimiManagedRoot,
  legacyCodexMarketplaceNote,
  ompEntryVersion,
  parseCodexInstalledEntries,
  parseCodexInstalledPluginIds,
  parseCodexMarketplaceNames,
  parseDshLoaderEntries,
  parseOmpPluginList,
  projectInstallPath,
  readInstalledFallbacksVersion,
  resolveCliPath,
  resolveDshHome,
  resolveDshProfileDir,
  resolveProjectRoot,
  spawnProcess,
  startDashboard,
  validateAgentPlugin,
  validateCommandDefinitions,
  validateOpencodeConfig
};
