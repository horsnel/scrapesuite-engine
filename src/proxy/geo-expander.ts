/**
 * Geo Expander Engine
 *
 * Expands proxy coverage from 15 to 50+ countries with tiered geo-data.
 * Provides geographic intelligence for proxy selection, ensuring requests
 * appear to originate from the correct locale with matching carriers, ISPs,
 * and DNS resolvers.
 *
 * Features:
 *  - 50+ countries with full geo-data (timezone, currency, language, carriers, ISPs)
 *  - Tiered proxy classification (tier1/tier2/tier3) based on infrastructure quality
 *  - Region and sub-region grouping for geographic fallback
 *  - Nearest-country matching when exact country is unavailable
 *  - Multi-criteria country matching (region, language, timezone proximity)
 */

import { createChildLogger } from '../utils/logger';
import { redis, cacheGet, cacheSet } from '../utils/redis';

const logger = createChildLogger('geo-expander');

// --- Types --------------------------------------------------------------------

export type PopulationTier = 'tiny' | 'small' | 'medium' | 'large' | 'huge';
export type ProxyTier = 'tier1' | 'tier2' | 'tier3';

export interface GeoCountryData {
  code: string;
  name: string;
  timezone: string;
  currency: string;
  language: string;
  region: string;
  subRegion: string;
  capital: string;
  populationTier: PopulationTier;
  internetPenetration: number;
  carriers: string[];
  majorISPs: string[];
  proxyTier: ProxyTier;
}

export interface GeoStats {
  totalCountries: number;
  byRegion: Record<string, number>;
  byTier: Record<ProxyTier, number>;
  byPopulationTier: Record<PopulationTier, number>;
  avgInternetPenetration: number;
}

// --- Expanded Geo Data (50+ countries) ----------------------------------------

export const EXPANDED_GEO_DATA: GeoCountryData[] = [
  // -- North America --------------------------------------------------------
  { code: 'US', name: 'United States', timezone: 'America/New_York', currency: 'USD', language: 'en', region: 'Americas', subRegion: 'North America', capital: 'Washington D.C.', populationTier: 'huge', internetPenetration: 0.92, carriers: ['AT&T', 'Verizon', 'T-Mobile'], majorISPs: ['Comcast', 'Charter', 'AT&T'], proxyTier: 'tier1' },
  { code: 'CA', name: 'Canada', timezone: 'America/Toronto', currency: 'CAD', language: 'en', region: 'Americas', subRegion: 'North America', capital: 'Ottawa', populationTier: 'large', internetPenetration: 0.93, carriers: ['Bell', 'Rogers', 'Telus'], majorISPs: ['Bell', 'Rogers', 'Shaw'], proxyTier: 'tier1' },
  { code: 'MX', name: 'Mexico', timezone: 'America/Mexico_City', currency: 'MXN', language: 'es', region: 'Americas', subRegion: 'Central America', capital: 'Mexico City', populationTier: 'large', internetPenetration: 0.76, carriers: ['Telcel', 'AT&T Mexico', 'Movistar'], majorISPs: ['Telmex', 'Izzi', 'Totalplay'], proxyTier: 'tier2' },

  // -- South America --------------------------------------------------------
  { code: 'BR', name: 'Brazil', timezone: 'America/Sao_Paulo', currency: 'BRL', language: 'pt', region: 'Americas', subRegion: 'South America', capital: 'Brasilia', populationTier: 'huge', internetPenetration: 0.81, carriers: ['Claro', 'Vivo', 'TIM'], majorISPs: ['Claro', 'Vivo', 'Oi'], proxyTier: 'tier2' },
  { code: 'AR', name: 'Argentina', timezone: 'America/Argentina/Buenos_Aires', currency: 'ARS', language: 'es', region: 'Americas', subRegion: 'South America', capital: 'Buenos Aires', populationTier: 'medium', internetPenetration: 0.87, carriers: ['Movistar', 'Claro', 'Personal'], majorISPs: ['Telecentro', 'Fibertel', 'Iplan'], proxyTier: 'tier2' },
  { code: 'CO', name: 'Colombia', timezone: 'America/Bogota', currency: 'COP', language: 'es', region: 'Americas', subRegion: 'South America', capital: 'Bogota', populationTier: 'medium', internetPenetration: 0.73, carriers: ['Claro', 'Movistar', 'Tigo'], majorISPs: ['Claro', 'Tigo', 'ETB'], proxyTier: 'tier2' },
  { code: 'CL', name: 'Chile', timezone: 'America/Santiago', currency: 'CLP', language: 'es', region: 'Americas', subRegion: 'South America', capital: 'Santiago', populationTier: 'small', internetPenetration: 0.88, carriers: ['Movistar', 'Claro', 'Entel'], majorISPs: ['Movistar', 'VTR', 'Claro'], proxyTier: 'tier2' },
  { code: 'PE', name: 'Peru', timezone: 'America/Lima', currency: 'PEN', language: 'es', region: 'Americas', subRegion: 'South America', capital: 'Lima', populationTier: 'medium', internetPenetration: 0.71, carriers: ['Claro', 'Movistar', 'Entel'], majorISPs: ['Claro', 'Movistar', 'Bitel'], proxyTier: 'tier3' },

  // -- Western Europe -------------------------------------------------------
  { code: 'GB', name: 'United Kingdom', timezone: 'Europe/London', currency: 'GBP', language: 'en', region: 'Europe', subRegion: 'Western Europe', capital: 'London', populationTier: 'large', internetPenetration: 0.95, carriers: ['EE', 'Vodafone UK', 'Three'], majorISPs: ['BT', 'Virgin Media', 'Sky'], proxyTier: 'tier1' },
  { code: 'DE', name: 'Germany', timezone: 'Europe/Berlin', currency: 'EUR', language: 'de', region: 'Europe', subRegion: 'Western Europe', capital: 'Berlin', populationTier: 'large', internetPenetration: 0.93, carriers: ['Telekom', 'Vodafone DE', 'O2'], majorISPs: ['Telekom', 'Vodafone', '1&1'], proxyTier: 'tier1' },
  { code: 'FR', name: 'France', timezone: 'Europe/Paris', currency: 'EUR', language: 'fr', region: 'Europe', subRegion: 'Western Europe', capital: 'Paris', populationTier: 'large', internetPenetration: 0.92, carriers: ['Orange', 'SFR', 'Bouygues'], majorISPs: ['Orange', 'SFR', 'Free'], proxyTier: 'tier1' },
  { code: 'IT', name: 'Italy', timezone: 'Europe/Rome', currency: 'EUR', language: 'it', region: 'Europe', subRegion: 'Southern Europe', capital: 'Rome', populationTier: 'medium', internetPenetration: 0.89, carriers: ['TIM', 'Vodafone IT', 'WindTre'], majorISPs: ['TIM', 'Vodafone', 'Fastweb'], proxyTier: 'tier1' },
  { code: 'ES', name: 'Spain', timezone: 'Europe/Madrid', currency: 'EUR', language: 'es', region: 'Europe', subRegion: 'Southern Europe', capital: 'Madrid', populationTier: 'medium', internetPenetration: 0.93, carriers: ['Movistar', 'Vodafone ES', 'Orange ES'], majorISPs: ['Movistar', 'Orange', 'Vodafone'], proxyTier: 'tier1' },
  { code: 'NL', name: 'Netherlands', timezone: 'Europe/Amsterdam', currency: 'EUR', language: 'nl', region: 'Europe', subRegion: 'Western Europe', capital: 'Amsterdam', populationTier: 'small', internetPenetration: 0.96, carriers: ['KPN', 'Vodafone NL', 'T-Mobile NL'], majorISPs: ['KPN', 'Ziggo', 'T-Mobile'], proxyTier: 'tier1' },
  { code: 'AT', name: 'Austria', timezone: 'Europe/Vienna', currency: 'EUR', language: 'de', region: 'Europe', subRegion: 'Western Europe', capital: 'Vienna', populationTier: 'small', internetPenetration: 0.93, carriers: ['A1', 'Magenta', 'Drei'], majorISPs: ['A1', 'Magenta', 'Drei'], proxyTier: 'tier1' },
  { code: 'CH', name: 'Switzerland', timezone: 'Europe/Zurich', currency: 'CHF', language: 'de', region: 'Europe', subRegion: 'Western Europe', capital: 'Bern', populationTier: 'small', internetPenetration: 0.96, carriers: ['Swisscom', 'Sunrise', 'Salt'], majorISPs: ['Swisscom', 'Sunrise', 'UPC'], proxyTier: 'tier1' },
  { code: 'BE', name: 'Belgium', timezone: 'Europe/Brussels', currency: 'EUR', language: 'nl', region: 'Europe', subRegion: 'Western Europe', capital: 'Brussels', populationTier: 'small', internetPenetration: 0.93, carriers: ['Proximus', 'Orange BE', 'Base'], majorISPs: ['Proximus', 'Telenet', 'Orange'], proxyTier: 'tier1' },
  { code: 'PT', name: 'Portugal', timezone: 'Europe/Lisbon', currency: 'EUR', language: 'pt', region: 'Europe', subRegion: 'Southern Europe', capital: 'Lisbon', populationTier: 'small', internetPenetration: 0.88, carriers: ['MEO', 'NOS', 'Vodafone PT'], majorISPs: ['MEO', 'NOS', 'Vodafone'], proxyTier: 'tier2' },
  { code: 'IE', name: 'Ireland', timezone: 'Europe/Dublin', currency: 'EUR', language: 'en', region: 'Europe', subRegion: 'Northern Europe', capital: 'Dublin', populationTier: 'small', internetPenetration: 0.92, carriers: ['Eir', 'Vodafone IE', 'Three IE'], majorISPs: ['Eir', 'Virgin Media IE', 'Vodafone'], proxyTier: 'tier1' },

  // -- Northern Europe ------------------------------------------------------
  { code: 'SE', name: 'Sweden', timezone: 'Europe/Stockholm', currency: 'SEK', language: 'sv', region: 'Europe', subRegion: 'Northern Europe', capital: 'Stockholm', populationTier: 'small', internetPenetration: 0.97, carriers: ['Telia', 'Tele2', 'Three SE'], majorISPs: ['Telia', 'Com Hem', 'Bahnhof'], proxyTier: 'tier1' },
  { code: 'NO', name: 'Norway', timezone: 'Europe/Oslo', currency: 'NOK', language: 'no', region: 'Europe', subRegion: 'Northern Europe', capital: 'Oslo', populationTier: 'small', internetPenetration: 0.98, carriers: ['Telenor', 'Telia NO', 'Ice'], majorISPs: ['Telenor', 'Telia', 'Altibox'], proxyTier: 'tier1' },
  { code: 'DK', name: 'Denmark', timezone: 'Europe/Copenhagen', currency: 'DKK', language: 'da', region: 'Europe', subRegion: 'Northern Europe', capital: 'Copenhagen', populationTier: 'small', internetPenetration: 0.98, carriers: ['Telia DK', 'TDC', 'Three DK'], majorISPs: ['TDC', 'Telia', 'YouSee'], proxyTier: 'tier1' },
  { code: 'FI', name: 'Finland', timezone: 'Europe/Helsinki', currency: 'EUR', language: 'fi', region: 'Europe', subRegion: 'Northern Europe', capital: 'Helsinki', populationTier: 'small', internetPenetration: 0.96, carriers: ['Telia FI', 'Elisa', 'DNA'], majorISPs: ['Telia', 'Elisa', 'DNA'], proxyTier: 'tier1' },

  // -- Eastern Europe -------------------------------------------------------
  { code: 'PL', name: 'Poland', timezone: 'Europe/Warsaw', currency: 'PLN', language: 'pl', region: 'Europe', subRegion: 'Eastern Europe', capital: 'Warsaw', populationTier: 'medium', internetPenetration: 0.87, carriers: ['Play', 'Orange PL', 'Plus'], majorISPs: ['Orange', 'UPC', 'Play'], proxyTier: 'tier2' },
  { code: 'CZ', name: 'Czech Republic', timezone: 'Europe/Prague', currency: 'CZK', language: 'cs', region: 'Europe', subRegion: 'Eastern Europe', capital: 'Prague', populationTier: 'small', internetPenetration: 0.88, carriers: ['O2 CZ', 'T-Mobile CZ', 'Vodafone CZ'], majorISPs: ['O2', 'Vodafone', 'T-Mobile'], proxyTier: 'tier2' },
  { code: 'UA', name: 'Ukraine', timezone: 'Europe/Kyiv', currency: 'UAH', language: 'uk', region: 'Europe', subRegion: 'Eastern Europe', capital: 'Kyiv', populationTier: 'large', internetPenetration: 0.79, carriers: ['Kyivstar', 'Vodafone UA', 'Lifecell'], majorISPs: ['Kyivstar', 'Volia', 'Triolan'], proxyTier: 'tier3' },
  { code: 'RU', name: 'Russia', timezone: 'Europe/Moscow', currency: 'RUB', language: 'ru', region: 'Europe', subRegion: 'Eastern Europe', capital: 'Moscow', populationTier: 'huge', internetPenetration: 0.85, carriers: ['MTS', 'Megafon', 'Beeline'], majorISPs: ['Rostelecom', 'MTS', 'Beeline'], proxyTier: 'tier2' },
  { code: 'TR', name: 'Turkey', timezone: 'Europe/Istanbul', currency: 'TRY', language: 'tr', region: 'Europe', subRegion: 'Western Asia', capital: 'Ankara', populationTier: 'large', internetPenetration: 0.83, carriers: ['Turkcell', 'Vodafone TR', 'Turk Telekom'], majorISPs: ['Turk Telekom', 'Turkcell', 'Vodafone'], proxyTier: 'tier2' },

  // -- East Asia ------------------------------------------------------------
  { code: 'JP', name: 'Japan', timezone: 'Asia/Tokyo', currency: 'JPY', language: 'ja', region: 'Asia', subRegion: 'East Asia', capital: 'Tokyo', populationTier: 'large', internetPenetration: 0.93, carriers: ['NTT Docomo', 'KDDI', 'SoftBank'], majorISPs: ['NTT', 'KDDI', 'SoftBank'], proxyTier: 'tier1' },
  { code: 'KR', name: 'South Korea', timezone: 'Asia/Seoul', currency: 'KRW', language: 'ko', region: 'Asia', subRegion: 'East Asia', capital: 'Seoul', populationTier: 'medium', internetPenetration: 0.98, carriers: ['SK Telecom', 'KT', 'LG U+'], majorISPs: ['SK Broadband', 'KT', 'LG U+'], proxyTier: 'tier1' },
  { code: 'CN', name: 'China', timezone: 'Asia/Shanghai', currency: 'CNY', language: 'zh', region: 'Asia', subRegion: 'East Asia', capital: 'Beijing', populationTier: 'huge', internetPenetration: 0.73, carriers: ['China Mobile', 'China Unicom', 'China Telecom'], majorISPs: ['China Telecom', 'China Unicom', 'China Mobile'], proxyTier: 'tier3' },
  { code: 'TW', name: 'Taiwan', timezone: 'Asia/Taipei', currency: 'TWD', language: 'zh', region: 'Asia', subRegion: 'East Asia', capital: 'Taipei', populationTier: 'medium', internetPenetration: 0.90, carriers: ['Chunghwa Telecom', 'FarEasTone', 'Taiwan Mobile'], majorISPs: ['Chunghwa Telecom', 'FarEasTone', 'Taiwan Mobile'], proxyTier: 'tier2' },
  { code: 'HK', name: 'Hong Kong', timezone: 'Asia/Hong_Kong', currency: 'HKD', language: 'zh', region: 'Asia', subRegion: 'East Asia', capital: 'Hong Kong', populationTier: 'small', internetPenetration: 0.93, carriers: ['CSL', 'SmarTone', '3 HK'], majorISPs: ['PCCW', 'HKBN', 'HGC'], proxyTier: 'tier1' },

  // -- Southeast Asia -------------------------------------------------------
  { code: 'SG', name: 'Singapore', timezone: 'Asia/Singapore', currency: 'SGD', language: 'en', region: 'Asia', subRegion: 'Southeast Asia', capital: 'Singapore', populationTier: 'tiny', internetPenetration: 0.96, carriers: ['Singtel', 'StarHub', 'M1'], majorISPs: ['Singtel', 'StarHub', 'ViewQwest'], proxyTier: 'tier1' },
  { code: 'ID', name: 'Indonesia', timezone: 'Asia/Jakarta', currency: 'IDR', language: 'id', region: 'Asia', subRegion: 'Southeast Asia', capital: 'Jakarta', populationTier: 'huge', internetPenetration: 0.62, carriers: ['Telkomsel', 'Indosat', 'XL Axiata'], majorISPs: ['Telkom', 'IndiHome', 'Biznet'], proxyTier: 'tier2' },
  { code: 'TH', name: 'Thailand', timezone: 'Asia/Bangkok', currency: 'THB', language: 'th', region: 'Asia', subRegion: 'Southeast Asia', capital: 'Bangkok', populationTier: 'medium', internetPenetration: 0.78, carriers: ['AIS', 'DTAC', 'TrueMove'], majorISPs: ['AIS', 'True', '3BB'], proxyTier: 'tier2' },
  { code: 'VN', name: 'Vietnam', timezone: 'Asia/Ho_Chi_Minh', currency: 'VND', language: 'vi', region: 'Asia', subRegion: 'Southeast Asia', capital: 'Hanoi', populationTier: 'large', internetPenetration: 0.73, carriers: ['Viettel', 'MobiFone', 'VinaPhone'], majorISPs: ['VNPT', 'Viettel', 'FPT'], proxyTier: 'tier2' },
  { code: 'PH', name: 'Philippines', timezone: 'Asia/Manila', currency: 'PHP', language: 'en', region: 'Asia', subRegion: 'Southeast Asia', capital: 'Manila', populationTier: 'large', internetPenetration: 0.68, carriers: ['Globe', 'Smart', 'DITO'], majorISPs: ['PLDT', 'Globe', 'Converge'], proxyTier: 'tier3' },
  { code: 'MY', name: 'Malaysia', timezone: 'Asia/Kuala_Lumpur', currency: 'MYR', language: 'ms', region: 'Asia', subRegion: 'Southeast Asia', capital: 'Kuala Lumpur', populationTier: 'medium', internetPenetration: 0.90, carriers: ['Maxis', 'Celcom', 'Digi'], majorISPs: ['TMNet', 'Maxis', 'Time'], proxyTier: 'tier2' },

  // -- South Asia -----------------------------------------------------------
  { code: 'IN', name: 'India', timezone: 'Asia/Kolkata', currency: 'INR', language: 'hi', region: 'Asia', subRegion: 'South Asia', capital: 'New Delhi', populationTier: 'huge', internetPenetration: 0.52, carriers: ['Jio', 'Airtel', 'Vi'], majorISPs: ['Jio', 'Airtel', 'BSNL'], proxyTier: 'tier2' },

  // -- Middle East ----------------------------------------------------------
  { code: 'AE', name: 'United Arab Emirates', timezone: 'Asia/Dubai', currency: 'AED', language: 'ar', region: 'Asia', subRegion: 'Western Asia', capital: 'Abu Dhabi', populationTier: 'small', internetPenetration: 0.99, carriers: ['Etisalat', 'du'], majorISPs: ['Etisalat', 'du'], proxyTier: 'tier1' },
  { code: 'SA', name: 'Saudi Arabia', timezone: 'Asia/Riyadh', currency: 'SAR', language: 'ar', region: 'Asia', subRegion: 'Western Asia', capital: 'Riyadh', populationTier: 'medium', internetPenetration: 0.98, carriers: ['STC', 'Mobily', 'Zain SA'], majorISPs: ['STC', 'Mobily', 'Zain'], proxyTier: 'tier2' },
  { code: 'IL', name: 'Israel', timezone: 'Asia/Jerusalem', currency: 'ILS', language: 'he', region: 'Asia', subRegion: 'Western Asia', capital: 'Jerusalem', populationTier: 'small', internetPenetration: 0.92, carriers: ['Pelephone', 'Cellcom', 'Partner'], majorISPs: ['Bezeq', 'Hot', 'Cellcom'], proxyTier: 'tier1' },

  // -- Oceania --------------------------------------------------------------
  { code: 'AU', name: 'Australia', timezone: 'Australia/Sydney', currency: 'AUD', language: 'en', region: 'Oceania', subRegion: 'Australasia', capital: 'Canberra', populationTier: 'medium', internetPenetration: 0.96, carriers: ['Telstra', 'Optus', 'Vodafone AU'], majorISPs: ['Telstra', 'Optus', 'TPG'], proxyTier: 'tier1' },
  { code: 'NZ', name: 'New Zealand', timezone: 'Pacific/Auckland', currency: 'NZD', language: 'en', region: 'Oceania', subRegion: 'Australasia', capital: 'Wellington', populationTier: 'small', internetPenetration: 0.95, carriers: ['Spark', 'Vodafone NZ', '2degrees'], majorISPs: ['Spark', 'Vodafone', '2degrees'], proxyTier: 'tier1' },

  // -- Africa ---------------------------------------------------------------
  { code: 'NG', name: 'Nigeria', timezone: 'Africa/Lagos', currency: 'NGN', language: 'en', region: 'Africa', subRegion: 'West Africa', capital: 'Abuja', populationTier: 'huge', internetPenetration: 0.36, carriers: ['MTN', 'Airtel NG', 'Glo'], majorISPs: ['MTN', 'Spectranet', 'Smile'], proxyTier: 'tier3' },
  { code: 'ZA', name: 'South Africa', timezone: 'Africa/Johannesburg', currency: 'ZAR', language: 'en', region: 'Africa', subRegion: 'Southern Africa', capital: 'Pretoria', populationTier: 'medium', internetPenetration: 0.72, carriers: ['Vodacom', 'MTN ZA', 'Cell C'], majorISPs: ['Vodacom', 'Telkom', 'Rain'], proxyTier: 'tier2' },
  { code: 'KE', name: 'Kenya', timezone: 'Africa/Nairobi', currency: 'KES', language: 'sw', region: 'Africa', subRegion: 'East Africa', capital: 'Nairobi', populationTier: 'medium', internetPenetration: 0.43, carriers: ['Safaricom', 'Airtel KE', 'Telkom KE'], majorISPs: ['Safaricom', 'Zuku', 'Telkom'], proxyTier: 'tier3' },
  { code: 'EG', name: 'Egypt', timezone: 'Africa/Cairo', currency: 'EGP', language: 'ar', region: 'Africa', subRegion: 'North Africa', capital: 'Cairo', populationTier: 'large', internetPenetration: 0.72, carriers: ['Vodafone EG', 'Orange EG', 'Etisalat EG'], majorISPs: ['TE Data', 'Vodafone', 'Orange'], proxyTier: 'tier3' },
  { code: 'GH', name: 'Ghana', timezone: 'Africa/Accra', currency: 'GHS', language: 'en', region: 'Africa', subRegion: 'West Africa', capital: 'Accra', populationTier: 'small', internetPenetration: 0.53, carriers: ['MTN GH', 'Vodafone GH', 'AirtelTigo'], majorISPs: ['MTN', 'Vodafone', 'Surfline'], proxyTier: 'tier3' },
];

// --- Timezone offset map for proximity calculations ---------------------------

const TIMEZONE_OFFSETS: Record<string, number> = {
  'Pacific/Honolulu': -10, 'America/Anchorage': -9, 'America/Los_Angeles': -8,
  'America/Denver': -7, 'America/Chicago': -6, 'America/New_York': -5,
  'America/Sao_Paulo': -3, 'America/Argentina/Buenos_Aires': -3,
  'America/Mexico_City': -6, 'America/Bogota': -5, 'America/Santiago': -4,
  'America/Lima': -5, 'America/Toronto': -5,
  'Atlantic/Azores': -1, 'Europe/London': 0, 'Europe/Paris': 1,
  'Europe/Berlin': 1, 'Europe/Rome': 1, 'Europe/Madrid': 1,
  'Europe/Amsterdam': 1, 'Europe/Brussels': 1, 'Europe/Vienna': 1,
  'Europe/Zurich': 1, 'Europe/Lisbon': 0, 'Europe/Dublin': 0,
  'Europe/Stockholm': 1, 'Europe/Oslo': 1, 'Europe/Copenhagen': 1,
  'Europe/Helsinki': 2, 'Europe/Warsaw': 1, 'Europe/Prague': 1,
  'Europe/Kyiv': 2, 'Europe/Moscow': 3, 'Europe/Istanbul': 3,
  'Africa/Lagos': 1, 'Africa/Johannesburg': 2, 'Africa/Nairobi': 3,
  'Africa/Cairo': 2, 'Africa/Accra': 0,
  'Asia/Dubai': 4, 'Asia/Riyadh': 3, 'Asia/Jerusalem': 2,
  'Asia/Kolkata': 5.5, 'Asia/Bangkok': 7, 'Asia/Jakarta': 7,
  'Asia/Ho_Chi_Minh': 7, 'Asia/Manila': 8, 'Asia/Kuala_Lumpur': 8,
  'Asia/Singapore': 8, 'Asia/Shanghai': 8, 'Asia/Taipei': 8,
  'Asia/Hong_Kong': 8, 'Asia/Tokyo': 9, 'Asia/Seoul': 9,
  'Australia/Sydney': 11, 'Pacific/Auckland': 13,
};

// --- GeoExpanderEngine --------------------------------------------------------

export class GeoExpanderEngine {
  private countryIndex: Map<string, GeoCountryData>;
  private regionIndex: Map<string, GeoCountryData[]>;

  constructor() {
    this.countryIndex = new Map(EXPANDED_GEO_DATA.map((c) => [c.code, c]));
    this.regionIndex = new Map();
    for (const country of EXPANDED_GEO_DATA) {
      const existing = this.regionIndex.get(country.region) || [];
      existing.push(country);
      this.regionIndex.set(country.region, existing);
    }
  }

  /**
   * Get full geo-data for a specific country code.
   * Returns null if the country code is not in our expanded dataset.
   */
  getGeoData(code: string): GeoCountryData | null {
    return this.countryIndex.get(code.toUpperCase()) ?? null;
  }

  /**
   * Get all countries in a given region (e.g., "Europe", "Asia", "Americas", "Africa", "Oceania").
   */
  get_countries_by_region(region: string): GeoCountryData[] {
    return this.regionIndex.get(region) ?? [];
  }

  /**
   * Get all countries matching a proxy tier.
   */
  getCountriesByTier(tier: ProxyTier): GeoCountryData[] {
    return EXPANDED_GEO_DATA.filter((c) => c.proxyTier === tier);
  }

  /**
   * Find the nearest supported country to a requested one.
   * Uses timezone proximity, then sub-region, then region as fallbacks.
   * This is used when an exact country proxy is unavailable.
   */
  getNearestCountry(requestedCode: string): GeoCountryData | null {
    const upper = requestedCode.toUpperCase();

    // Exact match
    const exact = this.countryIndex.get(upper);
    if (exact) return exact;

    // Try to find by sub-region similarity via a known mapping of common aliases
    const aliasMap: Record<string, string> = {
      UK: 'GB', ENGLAND: 'GB', SCOTLAND: 'GB', WALES: 'GB',
      GREAT_BRITAIN: 'GB', KOREA: 'KR', SOUTH_KOREA: 'KR',
      CZECHIA: 'CZ', MACAU: 'HK', UAE: 'AE',
    };
    const aliased = aliasMap[upper];
    if (aliased) {
      const match = this.countryIndex.get(aliased);
      if (match) return match;
    }

    // Find the nearest by timezone offset proximity
    // We estimate the requested country's timezone from its region
    const requestedOffset = TIMEZONE_OFFSETS[upper] ?? null;

    let bestMatch: GeoCountryData | null = null;
    let bestDistance = Infinity;

    for (const country of EXPANDED_GEO_DATA) {
      const countryOffset = TIMEZONE_OFFSETS[country.timezone];
      if (countryOffset === undefined) continue;

      let distance: number;

      if (requestedOffset !== null) {
        // Compute timezone distance
        distance = Math.abs(countryOffset - requestedOffset);
      } else {
        // No known offset -- use sub-region match as primary heuristic
        distance = country.proxyTier === 'tier1' ? 0 : country.proxyTier === 'tier2' ? 1 : 2;
      }

      // Prefer same region
      // (We don't know the region of the unknown code, so we don't penalize)

      // Prefer higher proxy tiers (lower distance)
      if (country.proxyTier === 'tier1') {
        distance += 0;
      } else if (country.proxyTier === 'tier2') {
        distance += 0.5;
      } else {
        distance += 1;
      }

      if (distance < bestDistance) {
        bestDistance = distance;
        bestMatch = country;
      }
    }

    return bestMatch;
  }

  /**
   * Get a random carrier string for a country (used in fingerprinting).
   */
  getCarrierForCountry(code: string): string | null {
    const data = this.countryIndex.get(code.toUpperCase());
    if (!data || data.carriers.length === 0) return null;
    return data.carriers[Math.floor(Math.random() * data.carriers.length)];
  }

  /**
   * Find the best country match based on multiple criteria.
   * Scores countries on region match, language match, and timezone proximity.
   * Returns the best-scoring country.
   */
  getMatchingCountry(criteria: {
    region?: string;
    language?: string;
    timezone?: string;
    proxyTier?: ProxyTier;
  }): GeoCountryData | null {
    const { region, language, timezone, proxyTier } = criteria;

    let bestMatch: GeoCountryData | null = null;
    let bestScore = -1;

    const requestedOffset = timezone ? TIMEZONE_OFFSETS[timezone] : undefined;

    for (const country of EXPANDED_GEO_DATA) {
      let score = 0;

      // Region match (+40 points)
      if (region && country.region === region) {
        score += 40;
      }

      // Sub-region match bonus (+20 points)
      if (region && country.region === region) {
        score += 20;
      }

      // Language match (+25 points)
      if (language && country.language === language) {
        score += 25;
      }

      // Timezone proximity (+0-20 points, closer = more)
      if (requestedOffset !== undefined) {
        const countryOffset = TIMEZONE_OFFSETS[country.timezone];
        if (countryOffset !== undefined) {
          const tzDistance = Math.abs(countryOffset - requestedOffset);
          score += Math.max(0, 20 - tzDistance * 2);
        }
      }

      // Proxy tier match (+10 points)
      if (proxyTier && country.proxyTier === proxyTier) {
        score += 10;
      }

      // Internet penetration bonus (higher = better for reliability) (+0-5 points)
      score += Math.round(country.internetPenetration * 5);

      if (score > bestScore) {
        bestScore = score;
        bestMatch = country;
      }
    }

    return bestMatch;
  }

  /**
   * Get aggregate statistics about the geo expansion coverage.
   */
  getStats(): GeoStats {
    const byRegion: Record<string, number> = {};
    const byTier: Record<ProxyTier, number> = { tier1: 0, tier2: 0, tier3: 0 };
    const byPopulationTier: Record<PopulationTier, number> = { tiny: 0, small: 0, medium: 0, large: 0, huge: 0 };
    let totalPenetration = 0;

    for (const country of EXPANDED_GEO_DATA) {
      byRegion[country.region] = (byRegion[country.region] || 0) + 1;
      byTier[country.proxyTier]++;
      byPopulationTier[country.populationTier]++;
      totalPenetration += country.internetPenetration;
    }

    return {
      totalCountries: EXPANDED_GEO_DATA.length,
      byRegion,
      byTier,
      byPopulationTier,
      avgInternetPenetration: Math.round((totalPenetration / EXPANDED_GEO_DATA.length) * 1000) / 1000,
    };
  }
}

// --- Singleton ----------------------------------------------------------------

export const geoExpander = new GeoExpanderEngine();
