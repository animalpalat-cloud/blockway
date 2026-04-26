/**
 * Injected into proxied HTML <head>. Routes fetch/XHR/history/anchors
 * for the *target* origin through /proxy?url=...
 */
export function buildClientRuntimePatch(targetOrigin: string): string {
  const O = JSON.stringify(targetOrigin);
  return [
    "(function(){",
    "var O=" + O + ";",
    "function p(u){if(u==null||u==='')return u;try{",
    "var s=String(u);if(s.indexOf('/proxy?url=')===0)return s;",
    "var x=/^[a-zA-Z][a-zA-Z+.-]*:/.test(s)?new URL(s):new URL(s,O);",
    "if(x.origin===O){var r=(typeof location!=='undefined'&&location.href)?location.href:O+'/';",
    "return '/proxy?url='+encodeURIComponent(x.href)+'&ref='+encodeURIComponent(r);}",
    "}catch(e){}return u;}",
    "if(typeof window!=='undefined'&&typeof window.fetch==='function'){var f=window.fetch;window.fetch=function(i,init){",
    "if(typeof i==='string')return f.call(this,p(i),init);",
    "return f.call(this,i,init);};}",
    "if(window.XMLHttpRequest){",
    "var o=XMLHttpRequest.prototype.open;",
    "XMLHttpRequest.prototype.open=function(){var a=[].slice.call(arguments);a[1]=p(a[1]);return o.apply(this,a);};}",
    "var psh=history.pushState,rst=history.replaceState;",
    "history.pushState=function(st,ti,ur){",
    "if(typeof ur==='string'&&ur)try{var u2=new URL(ur,O+'/');if(u2.origin===O)ur=p(u2.href);}catch(e){}",
    "return psh.apply(this,arguments);};",
    "history.replaceState=function(st,ti,ur){",
    "if(typeof ur==='string'&&ur)try{var u3=new URL(ur,O+'/');if(u3.origin===O)ur=p(u3.href);}catch(e){}",
    "return rst.apply(this,arguments);};",
    "document.addEventListener('click',function(e){",
    "var t=e.target,n=0;while(t&&t.tagName!=='A'&&n++<14)t=t.parentNode;",
    "if(!t||t.tagName!=='A')return;var h=t.getAttribute('href');if(!h||h[0]==='#')return;",
    "try{var w=new URL(t.href,location.href);if(w.origin===O){e.preventDefault();e.stopImmediatePropagation?e.stopImmediatePropagation():0;location.assign(p(w.href));}}catch(b){}}",
    ",!0);",
    "})();",
  ].join("");
}
