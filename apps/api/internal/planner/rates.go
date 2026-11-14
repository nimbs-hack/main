// Package planner works out what a crew needs for a mission: food energy and
// nutrients, water, oxygen and electricity, plus the carbon dioxide and body
// heat the vehicle has to deal with. It also reads and writes the mission
// file, a single CCSDS Space Packet.
package planner

// Every rate the planner uses, with where it comes from. Nothing here is
// measured by us. Values marked ASSUMED have no published source behind them
// and are planning choices.
//
// BVAD     NASA Life Support Baseline Values and Assumptions Document,
//          NASA/TP-2015-218570/REV1, January 2018.
// STD-3001 NASA-STD-3001 Volume 2, section 7 (food and nutrition).
// HASF     Smith, Zwart, Douglas, Heer. Human Adaptation to Spaceflight: The
//          Role of Food and Nutrition, 2nd edition, NASA, 2021. Table 1,
//          "Exploration Requirements (2020)".

const (
	KJPerKcal = 4.184
	mjPerKcal = KJPerKcal / 1000

	// BVAD Table 3-33: nominal balance for an 82 kg crewmember. One table, so
	// the ratios between its rows stay consistent when scaled by food energy.
	bvadFoodEnergyMJ = 12.59
	OxygenKgPerMJ    = 0.816 / bvadFoodEnergyMJ
	CO2KgPerMJ       = 1.04 / bvadFoodEnergyMJ
	HeatMJPerMJ      = 12.0 / bvadFoodEnergyMJ
	// Food mass as eaten, before packaging.
	FoodKgPerMJ = 1.51 / bvadFoodEnergyMJ
	// BVAD section 4.3: "an additional ~17 % mass penalty ... for individually
	// packaged meals".
	FoodPackagingFraction = 0.17

	// BVAD Table 4-20: 2.00 kg drinking plus 0.50 kg food rehydration per
	// crewmember per day, the same for every mission class.
	PotableWaterKgPerDay = 2.5

	// HASF Table 1: fluid of 32 mL per kg of body mass, with a floor by sex.
	FluidLPerKg = 0.032

	// STD-3001 [V2 7004]: 837 kJ (200 kcal) more food per hour of EVA.
	EVAFoodKcalPerHour = 200
	EVAFoodMJPerHour   = EVAFoodKcalPerHour * mjPerKcal
	// BVAD Table 4-76: drinking water during EVA.
	EVADrinkKgPerHour = 0.24
	// BVAD Table 4-75, nominal values for lunar surface suits. Both leave the
	// suit and never come back to the vehicle, so recycling cannot recover
	// them. The cooling figure is the equatorial one; polar sites lose about half.
	EVAOxygenLossKgPerHour   = 0.092
	EVACoolingWaterKgPerHour = 0.625

	// BVAD Table 3-2, ISS average power by system (Pritchett, 2014).
	// Per crewmember: life support 5.31 kW, crew equipment 1.07 kW and crew
	// health care 0.11 kW, shared between the six people ISS carried in 2014.
	// Dividing by six is our reading; the table does not give a crew size.
	// Rounded to 10 W, the resolution the mission file stores.
	CrewPowerW = 1080
	// Station housekeeping from the same table: data handling 4.08, comms
	// 2.90, power system 2.02, guidance 0.62, mechanisms 0.19, thermal
	// control 8.72 kW.
	StationBasePowerW = 18530

	// ISS state of the art for regenerative life support.
	// Water: NASA, "NASA Achieves Water Recovery Milestone on International
	// Space Station", 2023. Oxygen: the Sabatier process, about half of the
	// oxygen in exhaled carbon dioxide (NASA ICES-2024-168).
	ISSWaterRecovery  = 0.98
	ISSOxygenRecovery = 0.5

	// ASSUMED. Share added on top of everything the crew has to bring or
	// generate. A mission file can set its own.
	DefaultMarginPercent = 10
)

// HASF Table 1: the least fluid a day, in litres.
var fluidFloorL = map[string]float64{"female": 2.1, "male": 2.5}

// Dietary Reference Intake equations for adults 19 and older (Institute of
// Medicine, 2005). STD-3001 [V2 7003] and HASF both point at them, and
// STD-3001 says to use the "active" factor of 1.25.
//
//	EER = base - perYear * age + PA * (perKg * mass + perMetre * height)
type eerCoefficients struct{ base, perYear, perKg, perMetre float64 }

var eer = map[string]eerCoefficients{
	"male":   {662, 9.53, 15.91, 539.6},
	"female": {354, 6.91, 9.36, 726},
}

var activityFactor = map[string]map[string]float64{
	"male":   {"sedentary": 1.0, "low": 1.11, "active": 1.25, "very-active": 1.48},
	"female": {"sedentary": 1.0, "low": 1.12, "active": 1.27, "very-active": 1.45},
}

// HASF Table 1, exploration requirements. Shares are of daily food energy.
const (
	proteinMinGPerKg     = 1.2
	proteinMaxGPerKg     = 1.8
	carbohydrateMinShare = 0.45
	carbohydrateMaxShare = 0.65
	fatMinShare          = 0.2
	fatMaxShare          = 0.35
	kcalPerGCarbohydrate = 4
	kcalPerGFat          = 9
)

// HASF Table 1, per day. Where the table gives a range, max is set.
// Iron is 18 mg for women under 50 who do not suppress menstruation; the
// profile does not record that, so the planner reports the 8 mg figure.
type nutrientTarget struct {
	id, label, unit string
	female, male    float64
	max             float64 // 0 when the table gives a single value
}

var nutrientTargets = []nutrientTarget{
	{"fiber", "Fiber", "g", 25, 38, 0},
	{"omega6", "Omega-6 fatty acids", "g", 12, 17, 0},
	{"omega3", "Omega-3 fatty acids", "g", 1.1, 1.6, 0},
	{"calcium", "Calcium", "mg", 1000, 1000, 1200},
	{"phosphorus", "Phosphorus", "mg", 700, 700, 0},
	{"magnesium", "Magnesium", "mg", 320, 420, 0},
	{"sodium", "Sodium", "mg", 1500, 1500, 2300},
	{"potassium", "Potassium", "mg", 2600, 3400, 0},
	{"iron", "Iron", "mg", 8, 8, 0},
	{"zinc", "Zinc", "mg", 8, 11, 0},
	{"vitaminA", "Vitamin A", "µg", 700, 900, 0},
	{"vitaminC", "Vitamin C", "mg", 110, 125, 0},
	{"vitaminD", "Vitamin D", "µg", 25, 25, 0},
	{"vitaminE", "Vitamin E", "mg", 15, 15, 0},
	{"vitaminK", "Vitamin K", "µg", 90, 120, 0},
	{"vitaminB12", "Vitamin B12", "µg", 2.4, 2.4, 0},
	{"folate", "Folate", "µg", 400, 400, 0},
}
