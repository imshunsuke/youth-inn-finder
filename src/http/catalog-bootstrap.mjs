const allowedFields=['id','name','district','street','address','latitude','longitude','isOnShelf'];
export async function withCatalogBootstrap(response, catalogResponse, now=Date.now()) {
  if(response.status!==200 || !response.headers.get('Content-Type')?.includes('text/html') || catalogResponse?.status!==200) return response;
  let payload;
  try { payload=await catalogResponse.json(); } catch { return response; }
  const age=now-Date.parse(payload?.meta?.fetchedAt);
  if(!Array.isArray(payload?.data) || !Number.isFinite(age) || age<0 || age>=24*60*60_000) return response;
  const data=payload.data.slice(0,200).filter(x=>x && typeof x.id==='string' && typeof x.name==='string').map(x=>Object.fromEntries(allowedFields.filter(k=>Object.hasOwn(x,k)).map(k=>[k,x[k]])));
  const json=JSON.stringify({data,meta:{fetchedAt:payload.meta.fetchedAt,availabilityStatus:'unconfirmed'}})
    .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const html=await response.clone().text();
  const marker='<script type="module" src="/app.bundle.js"></script>';
  if(!html.includes(marker)) return response;
  const headers=new Headers(response.headers);
  for(const key of ['Content-Length','Content-Encoding','ETag']) headers.delete(key);
  headers.set('Cache-Control','no-store');
  return new Response(html.replace(marker,`<template id="bootstrap-catalog">${json}</template>${marker}`),{status:200,headers});
}
