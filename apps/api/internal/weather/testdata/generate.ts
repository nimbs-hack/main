// Regenerate with Bun. This reads the reviewed TS port source; Go tests only
// read the saved JSON and have no JavaScript or subprocess dependency.
const sourceRoot = Bun.argv[2];
if (!sourceRoot) throw new Error('Pass the reviewed algorithms-integration worktree path');
const { generateMartianWeather, evaluateEvaWeather } = await import(`${sourceRoot}/apps/api/src/weather/generator.ts`);
const { computeSiteWeatherField } = await import(`${sourceRoot}/apps/api/src/terrain/weatherField.ts`);
const { TerrainGraph } = await import(`${sourceRoot}/apps/api/src/terrain/engine.ts`);
const rows=7, cols=7;
const elevationsM=Array.from({length: rows*cols},(_,i)=>-2500+((i%cols)-3)*18+Math.floor(i/cols)*9-(i===24?80:0));
elevationsM[0]=-99999;
const meta={id:'jezero-weather-fixture',name:'Weather fixture',sourceItemId:'test',sourceTitle:'test',dtmUrl:'',hillshadeUrl:'',bbox:[77.442,18.661,77.448,18.667] as [number,number,number,number],center:{lat:18.664,lon:77.445},rows,cols,widthMeters:360,heightMeters:360,cellSizeMeters:60,minElevationM:Math.min(...elevationsM.filter(x=>x!==-99999)),maxElevationM:Math.max(...elevationsM),nodataValue:-99999};
const graph=new TerrainGraph({meta,elevationsM});
const cases=[];
for(const scenario of ['nominal','dust-storm','cold-snap'] as const) {
 const weather=generateMartianWeather({site:'jezero',siteMeta:meta,sol:1859,lsDeg:137,scenario});
 const fields=[3,12,23.5,24,36,47.5,48].map(lmstHour=>{const f=computeSiteWeatherField(graph,weather,lmstHour);return {lmstHour,tempK:Array.from(f.tempK),pressurePa:Array.from(f.pressurePa)};});
 const route={points:[{distanceM:0,elevationM:-2500},{distanceM:500,elevationM:-2450},{distanceM:1200,elevationM:-2510}]};
 const evaluation=evaluateEvaWeather(weather,{route,lmstHour:12});
 const { fetchedAt, ...stableWeather } = weather;
 cases.push({scenario,weather:stableWeather,fields,evaluation});
}
await Bun.write(new URL('./parity.json',import.meta.url),JSON.stringify({grid:{rows,cols,bbox:meta.bbox,elevations:elevationsM,valid:elevationsM.map(e=>e!==-99999),referenceElevationM:-2500,id:meta.id,name:meta.name,cellSizeMeters:60},cases},null,2)+'\n');
