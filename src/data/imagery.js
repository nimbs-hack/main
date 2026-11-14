// High resolution orbital mosaics from NASA Mars Trek, layered over the
// global Viking basemap at the rover sites. CTX is about 5 m/px, HiRISE
// about 25 cm/px. They use the same 2 x 1 geographic tile grid as Viking.
//
// Found with Trek's search API (TrekServices/ws/index/eq/searchItems) and
// each layer's WMTSCapabilities.xml. `bounds` is [west, south, east, north]
// in degrees, planetocentric, east longitude -180 to 180. `maxLevel` is the
// deepest tile matrix in the capabilities file.
const TREK_EQ = 'https://trek.nasa.gov/tiles/Mars/EQ'

export const tileUrl = (layer) => `${TREK_EQ}/${layer}/1.0.0/default/default028mm/{z}/{y}/{x}.png`

export const OVERLAYS = [
  // Gale crater, Curiosity
  { layer: 'Gale_CTX_BlockAdj_dd', instrument: 'CTX', bounds: [135.1842593, -6.5732988, 139.2413012, -2.8077809], maxLevel: 14 },
  { layer: 'curiosity_hirise_mosaic', instrument: 'HiRISE', bounds: [137.1224669, -4.9254743, 137.7298129, -4.2489588], maxLevel: 18 },
  // Jezero crater, Perseverance
  { layer: 'Jezero_CTX_BlockAdj_dd', instrument: 'CTX', bounds: [75.1537692, 15.9058484, 78.8717121, 19.4453003], maxLevel: 14 },
  { layer: 'JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first_dd', instrument: 'HiRISE', bounds: [77.2229331, 18.3067994, 77.583964, 18.669315], maxLevel: 19 },
  // Gusev crater, Spirit
  { layer: 'Gusev_CTX_BlockAdj_dd', instrument: 'CTX', bounds: [173.2463549, -16.2218451, 178.4633349, -10.9930557], maxLevel: 14 },
  { layer: 'spirit_hirise_mosaic', instrument: 'HiRISE', bounds: [175.4278511, -14.6925026, 175.5858031, -14.5357546], maxLevel: 19 },
  // Meridiani Planum, Opportunity
  { layer: 'S_Meridiani_Sinus_Planium_CTX_BlockAdj_dd', instrument: 'CTX', bounds: [-8.093484, -4.8925742, -2.8037058, -0.6078623], maxLevel: 14 },
  { layer: 'opportunity_hirise_mosaic', instrument: 'HiRISE', bounds: [-5.5964391, -2.7513281, -4.9954112, -1.8994384], maxLevel: 19 },
]
