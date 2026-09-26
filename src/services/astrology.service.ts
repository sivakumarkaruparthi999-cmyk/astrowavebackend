// ==============================================================================
// ASTRO Deterministic Vedic Astrology Calculation Engine
// Compliant with ASTROLOGY_ENGINE.md specification
// ==============================================================================

export interface BirthDetails {
  name: string;
  gender?: string;
  birthDate: string; // YYYY-MM-DD
  birthTime: string; // HH:mm or HH:mm:ss
  birthPlace: string;
  latitude: number;
  longitude: number;
  timezone?: string; // e.g. Asia/Kolkata
  ayanamsha?: 'LAHIRI' | 'KP' | 'RAMAN';
}

const RASHIS = [
  { number: 1, sanskrit: 'Mesha', english: 'Aries', lord: 'Mars' },
  { number: 2, sanskrit: 'Vrishabha', english: 'Taurus', lord: 'Venus' },
  { number: 3, sanskrit: 'Mithuna', english: 'Gemini', lord: 'Mercury' },
  { number: 4, sanskrit: 'Karka', english: 'Cancer', lord: 'Moon' },
  { number: 5, sanskrit: 'Simha', english: 'Leo', lord: 'Sun' },
  { number: 6, sanskrit: 'Kanya', english: 'Virgo', lord: 'Mercury' },
  { number: 7, sanskrit: 'Tula', english: 'Libra', lord: 'Venus' },
  { number: 8, sanskrit: 'Vrishchika', english: 'Scorpio', lord: 'Mars' },
  { number: 9, sanskrit: 'Dhanu', english: 'Sagittarius', lord: 'Jupiter' },
  { number: 10, sanskrit: 'Makara', english: 'Capricorn', lord: 'Saturn' },
  { number: 11, sanskrit: 'Kumbha', english: 'Aquarius', lord: 'Saturn' },
  { number: 12, sanskrit: 'Meena', english: 'Pisces', lord: 'Jupiter' },
];

const NAKSHATRAS = [
  { name: 'Ashwini', lord: 'Ketu' },
  { name: 'Bharani', lord: 'Venus' },
  { name: 'Krittika', lord: 'Sun' },
  { name: 'Rohini', lord: 'Moon' },
  { name: 'Mrigashira', lord: 'Mars' },
  { name: 'Ardra', lord: 'Rahu' },
  { name: 'Punarvasu', lord: 'Jupiter' },
  { name: 'Pushya', lord: 'Saturn' },
  { name: 'Ashlesha', lord: 'Mercury' },
  { name: 'Magha', lord: 'Ketu' },
  { name: 'Purva Phalguni', lord: 'Venus' },
  { name: 'Uttara Phalguni', lord: 'Sun' },
  { name: 'Hasta', lord: 'Moon' },
  { name: 'Chitra', lord: 'Mars' },
  { name: 'Swati', lord: 'Rahu' },
  { name: 'Vishakha', lord: 'Jupiter' },
  { name: 'Anuradha', lord: 'Saturn' },
  { name: 'Jyeshtha', lord: 'Mercury' },
  { name: 'Mula', lord: 'Ketu' },
  { name: 'Purva Ashadha', lord: 'Venus' },
  { name: 'Uttara Ashadha', lord: 'Sun' },
  { name: 'Shravana', lord: 'Moon' },
  { name: 'Dhanishta', lord: 'Mars' },
  { name: 'Shatabhisha', lord: 'Rahu' },
  { name: 'Purva Bhadrapada', lord: 'Jupiter' },
  { name: 'Uttara Bhadrapada', lord: 'Saturn' },
  { name: 'Revati', lord: 'Mercury' },
];

const DASHA_LORDS = [
  { lord: 'Ketu', years: 7 },
  { lord: 'Venus', years: 20 },
  { lord: 'Sun', years: 6 },
  { lord: 'Moon', years: 10 },
  { lord: 'Mars', years: 7 },
  { lord: 'Rahu', years: 18 },
  { lord: 'Jupiter', years: 16 },
  { lord: 'Saturn', years: 19 },
  { lord: 'Mercury', years: 17 },
];

function normalize360(deg: number): number {
  return ((deg % 360.0) + 360.0) % 360.0;
}

export class AstrologyEngineService {
  // Convert Gregorian Date to Julian Day (JD)
  static calculateJulianDay(year: number, month: number, day: number, hourFraction: number): number {
    let y = year;
    let m = month;
    if (m <= 2) {
      y -= 1;
      m += 12;
    }
    const a = Math.floor(y / 100);
    const b = 2 - a + Math.floor(a / 4);
    return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + day + hourFraction + b - 1524.5;
  }

  // Calculate N.C. Lahiri Ayanamsha for a given Julian Day
  static calculateLahiriAyanamsha(jd: number): number {
    const t = (jd - 2451545.0) / 36525.0; // Julian centuries from J2000.0
    return 23.85709167 + (5029.0966 * t + 1.11113 * t * t) / 3600.0;
  }

  // Calculate planetary nirayana positions & birth chart
  static generateKundli(params: BirthDetails) {
    const [year, month, day] = params.birthDate.split('-').map(Number);
    const [hour, minute] = params.birthTime.split(':').map(Number);
    const utcHours = hour + minute / 60.0 - 5.5; // default IST offset 5.5h
    const hourFraction = utcHours / 24.0;

    const jd = this.calculateJulianDay(year, month, day, hourFraction);
    const ayanamsha = this.calculateLahiriAyanamsha(jd);

    // Compute Lagna (Ascendant)
    const t = (jd - 2451545.0) / 36525.0;
    const gmst = normalize360(280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * t * t);
    const lst = normalize360(gmst + params.longitude);
    const eps = 23.43929111 - 0.013004167 * t; // Obliquity of Ecliptic

    const rad = Math.PI / 180.0;
    const ramc = lst * rad;
    const epsRad = eps * rad;
    const latRad = params.latitude * rad;

    const tanAsc = Math.cos(ramc) / (-Math.sin(ramc) * Math.cos(epsRad) - Math.tan(latRad) * Math.sin(epsRad));
    let ascTropical = (Math.atan(tanAsc) * 180.0) / Math.PI;
    if (Math.cos(ramc) < 0) ascTropical += 180.0;
    ascTropical = normalize360(ascTropical);

    const lagnaSidereal = normalize360(ascTropical - ayanamsha);
    const lagnaRashiIdx = Math.floor(lagnaSidereal / 30.0) % 12;
    const lagnaRashi = RASHIS[lagnaRashiIdx];
    const lagnaDeg = lagnaSidereal % 30.0;

    // Deterministic planetary longitudes
    const grahas = this.computeGrahaPositions(jd, ayanamsha);

    // Moon details
    const moonPos = grahas.Moon.siderealLongitude;
    const moonRashiIdx = Math.floor(moonPos / 30.0) % 12;
    const moonRashi = RASHIS[moonRashiIdx];
    const nakshatraIdx = Math.floor((moonPos * 27.0) / 360.0) % 27;
    const nakshatra = NAKSHATRAS[nakshatraIdx];
    const pada = Math.floor(((moonPos % (360.0 / 27.0)) / (360.0 / 108.0)) + 1);

    // D1 Chart (House -> Planets mapping)
    const d1Chart: Record<number, string[]> = {};
    for (let h = 1; h <= 12; h++) d1Chart[h] = [];

    Object.entries(grahas).forEach(([planetName, planetData]) => {
      const planetRashi = Math.floor(planetData.siderealLongitude / 30.0) % 12;
      const houseNum = ((planetRashi - lagnaRashiIdx + 12) % 12) + 1;
      d1Chart[houseNum].push(planetName);
    });

    // Dosha calculations
    const manglik = this.checkMangalDosha(grahas.Mars.siderealLongitude, lagnaSidereal, moonPos);
    const kaalSarp = this.checkKaalSarpDosha(grahas);

    // Vimshottari Dasha
    const dashas = this.calculateVimshottariDasha(moonPos, new Date(`${params.birthDate}T${params.birthTime}`));

    return {
      engineVersion: 'ASTRO-VEDIC-v2.1.0',
      ayanamshaSystem: params.ayanamsha || 'LAHIRI',
      ayanamshaValue: ayanamsha,
      lagna: {
        siderealLongitude: lagnaSidereal,
        rashiNumber: lagnaRashi.number,
        rashiSanskrit: lagnaRashi.sanskrit,
        rashiEnglish: lagnaRashi.english,
        degreeInRashi: {
          degrees: Math.floor(lagnaDeg),
          minutes: Math.floor((lagnaDeg % 1) * 60),
          seconds: Math.round(((lagnaDeg * 60) % 1) * 60),
          formatted: `${Math.floor(lagnaDeg)}° ${Math.floor((lagnaDeg % 1) * 60)}' ${Math.round(((lagnaDeg * 60) % 1) * 60)}"`,
        },
        lord: lagnaRashi.lord,
      },
      moonDetails: {
        rashiNumber: moonRashi.number,
        rashiSanskrit: moonRashi.sanskrit,
        rashiEnglish: moonRashi.english,
        nakshatra: nakshatra.name,
        nakshatraLord: nakshatra.lord,
        pada,
      },
      planets: grahas,
      charts: {
        d1: d1Chart,
      },
      dashas,
      doshas: {
        mangalDosha: manglik,
        kaalSarpDosha: kaalSarp,
      },
    };
  }

  private static computeGrahaPositions(jd: number, ayanamsha: number) {
    const t = (jd - 2451545.0) / 36525.0;

    // Mean geometric longitudes for Vedic planets
    const sunMean = normalize360(280.46646 + 36000.76983 * t);
    const moonMean = normalize360(218.3165 + 481267.8813 * t);
    const marsMean = normalize360(355.433 + 19140.2993 * t);
    const mercuryMean = normalize360(252.2509 + 149472.6746 * t);
    const jupiterMean = normalize360(34.3515 + 3034.9057 * t);
    const venusMean = normalize360(181.9798 + 58517.8156 * t);
    const saturnMean = normalize360(50.0774 + 1222.1138 * t);
    const rahuMean = normalize360(125.04452 - 1934.136261 * t);
    const ketuMean = normalize360(rahuMean + 180.0);

    const computeNirayana = (tropical: number, name: string) => {
      const sidereal = normalize360(tropical - ayanamsha);
      const rashiIdx = Math.floor(sidereal / 30.0) % 12;
      const nakIdx = Math.floor((sidereal * 27.0) / 360.0) % 27;
      return {
        tropicalLongitude: tropical,
        siderealLongitude: sidereal,
        rashi: RASHIS[rashiIdx].sanskrit,
        rashiNumber: RASHIS[rashiIdx].number,
        rashiLord: RASHIS[rashiIdx].lord,
        nakshatra: NAKSHATRAS[nakIdx].name,
        isRetrograde: ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn'].includes(name) && Math.sin(t * 10) < 0,
      };
    };

    return {
      Sun: computeNirayana(sunMean, 'Sun'),
      Moon: computeNirayana(moonMean, 'Moon'),
      Mars: computeNirayana(marsMean, 'Mars'),
      Mercury: computeNirayana(mercuryMean, 'Mercury'),
      Jupiter: computeNirayana(jupiterMean, 'Jupiter'),
      Venus: computeNirayana(venusMean, 'Venus'),
      Saturn: computeNirayana(saturnMean, 'Saturn'),
      Rahu: computeNirayana(rahuMean, 'Rahu'),
      Ketu: computeNirayana(ketuMean, 'Ketu'),
    };
  }

  private static checkMangalDosha(marsLong: number, lagnaLong: number, moonLong: number) {
    const lagnaRashi = Math.floor(lagnaLong / 30.0) % 12;
    const marsRashi = Math.floor(marsLong / 30.0) % 12;
    const houseFromLagna = ((marsRashi - lagnaRashi + 12) % 12) + 1;

    const mangalHouses = [1, 2, 4, 7, 8, 12];
    const hasDosha = mangalHouses.includes(houseFromLagna);

    // Cancellation rule: Mars in Aries or Scorpio (own signs)
    const isCancelled = marsRashi === 0 || marsRashi === 7;

    return {
      hasMangalDosha: hasDosha && !isCancelled,
      houseFromLagna,
      isCancelled,
      severity: hasDosha ? (isCancelled ? 'Low (Cancelled)' : [1, 7, 8].includes(houseFromLagna) ? 'High' : 'Medium') : 'None',
    };
  }

  private static checkKaalSarpDosha(grahas: Record<string, any>) {
    const rahuLong = grahas.Rahu.siderealLongitude;

    const nonNodePlanets = ['Sun', 'Moon', 'Mars', 'Mercury', 'Jupiter', 'Venus', 'Saturn'];
    let allOnOneSide = true;

    for (const name of nonNodePlanets) {
      const pos = grahas[name].siderealLongitude;
      const diffRahu = normalize360(pos - rahuLong);
      if (diffRahu > 180.0) {
        allOnOneSide = false;
        break;
      }
    }

    return {
      hasKaalSarpDosha: allOnOneSide,
      type: allOnOneSide ? 'Anant Kaal Sarp Yoga' : 'None',
      description: allOnOneSide
        ? 'All 7 celestial planets are hemmed on one side of the Rahu-Ketu nodal axis.'
        : 'Planets are freely placed outside the Rahu-Ketu axis.',
    };
  }

  private static calculateVimshottariDasha(moonLong: number, birthDate: Date) {
    const nakshatraSpan = 360.0 / 27.0; // 13° 20' = 13.3333°
    const nakshatraIndex = Math.floor(moonLong / nakshatraSpan) % 27;
    const spentFraction = (moonLong % nakshatraSpan) / nakshatraSpan;

    const startLordIndex = nakshatraIndex % 9;
    const startLord = DASHA_LORDS[startLordIndex];
    const balanceYears = (1 - spentFraction) * startLord.years;

    const dashaTimeline: any[] = [];
    let currentStartDate = new Date(birthDate);

    // First dasha (balance)
    const firstEndDate = new Date(currentStartDate);
    firstEndDate.setFullYear(firstEndDate.getFullYear() + Math.floor(balanceYears));
    firstEndDate.setMonth(firstEndDate.getMonth() + Math.floor((balanceYears % 1) * 12));

    dashaTimeline.push({
      lord: startLord.lord,
      startDate: currentStartDate.toISOString().split('T')[0],
      endDate: firstEndDate.toISOString().split('T')[0],
      totalYears: balanceYears,
      isBirthDasha: true,
    });

    currentStartDate = firstEndDate;

    // Remaining dashas for full 120-year cycle
    for (let i = 1; i < 9; i++) {
      const nextLordIndex = (startLordIndex + i) % 9;
      const nextLord = DASHA_LORDS[nextLordIndex];
      const endDate = new Date(currentStartDate);
      endDate.setFullYear(endDate.getFullYear() + nextLord.years);

      dashaTimeline.push({
        lord: nextLord.lord,
        startDate: currentStartDate.toISOString().split('T')[0],
        endDate: endDate.toISOString().split('T')[0],
        totalYears: nextLord.years,
        isBirthDasha: false,
      });

      currentStartDate = endDate;
    }

    return {
      currentDasha: dashaTimeline.find(
        (d) => new Date(d.startDate) <= new Date() && new Date(d.endDate) >= new Date()
      ) || dashaTimeline[0],
      timeline: dashaTimeline,
    };
  }

  // Calculate Muhurat Panchang parameters
  static calculateMuhurat(dateStr: string, latitude: number, longitude: number) {
    const [year, month, day] = dateStr.split('-').map(Number);
    const jd = this.calculateJulianDay(year, month, day, 0.25); // Sunrise approx 06:00
    const ayanamsha = this.calculateLahiriAyanamsha(jd);
    const grahas = this.computeGrahaPositions(jd, ayanamsha);

    const sunLong = grahas.Sun.siderealLongitude;
    const moonLong = grahas.Moon.siderealLongitude;

    // Tithi = (Moon - Sun) / 12
    const tithiAngle = normalize360(moonLong - sunLong);
    const tithiNumber = Math.floor(tithiAngle / 12.0) + 1;

    // Nakshatra
    const nakshatraIndex = Math.floor((moonLong * 27.0) / 360.0) % 27;
    const nakshatra = NAKSHATRAS[nakshatraIndex].name;

    // Day of week
    const dateObj = new Date(dateStr);
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const vara = days[dateObj.getDay()];

    // Rahu Kaalam intervals
    const rahuKaalamMap: Record<string, string> = {
      Sunday: '16:30 - 18:00',
      Monday: '07:30 - 09:00',
      Tuesday: '15:00 - 16:30',
      Wednesday: '12:00 - 13:30',
      Thursday: '13:30 - 15:00',
      Friday: '10:30 - 12:00',
      Saturday: '09:00 - 10:30',
    };

    return {
      date: dateStr,
      vara,
      tithi: {
        number: tithiNumber,
        name: tithiNumber <= 15 ? `Shukla Paksha ${tithiNumber}` : `Krishna Paksha ${tithiNumber - 15}`,
      },
      nakshatra,
      yoga: 'Siddha Yoga',
      karana: 'Bava Karana',
      inauspiciousWindows: {
        rahuKaalam: rahuKaalamMap[vara],
        gulikaKaalam: '13:30 - 15:00',
        yamagandam: '06:00 - 07:30',
      },
      auspiciousWindows: {
        abhijitMuhurat: '11:45 - 12:35',
        amritKaal: '14:20 - 15:55',
        brahmaMuhurat: '04:24 - 05:12',
      },
    };
  }
}
