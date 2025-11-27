import sys, json, time, math, argparse
from datetime import datetime, timezone, timedelta, date
from typing import Optional, List, Tuple, Dict
from functools import lru_cache
import numpy as np
import pandas as pd
import requests

VERSION = "novaLogic v1.4.2"
TZ = "Europe/Istanbul"

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

def iso_utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def yesterday() -> date:
    return (datetime.now(timezone.utc).date() - timedelta(days=1))

def safe_float(x):
    try:
        f = float(x)
        return f if np.isfinite(f) else None
    except:
        return None

def dprint(msg, dbg=False):
    if dbg:
        print(str(msg), flush=True)

UA = {"User-Agent": "novaLogic/1.4.2 (contact: alpagan@novacast.space)"}

def http_get_json(url, params=None, timeout=45, retries=3, backoff=1.25, debug=False):
    hdr = {"Accept":"application/json", **UA}
    last_err=None
    for a in range(max(1,int(retries))):
        try:
            r = requests.get(url, params=params or {}, headers=hdr, timeout=timeout)
            if r.status_code >= 500 or r.status_code in (429,):
                raise requests.exceptions.HTTPError(f"{r.status_code} {r.reason}")
            r.raise_for_status()
            return r.json()
        except requests.exceptions.RequestException as e:
            last_err=e
            dprint(f"[HTTP] {url} -> {e} (try {a+1}/{retries})", debug)
            time.sleep((backoff ** a))
    dprint(f"[HTTP] giving up: {last_err}", debug)
    return None

@lru_cache(maxsize=16)
def fetch_openmeteo_daily(lat: float, lon: float, forecast_days: int, past_days: int = 0, debug=False):
    forecast_days = int(max(1, min(forecast_days, 16)))
    past_days = int(max(0, min(past_days, 7)))
    daily = ",".join([
        "temperature_2m_max","temperature_2m_min",
        "precipitation_sum","precipitation_hours",
        "shortwave_radiation_sum","precipitation_probability_max",
        "rain_sum","snowfall_sum"  
    ])
    params = {
        "latitude": lat, "longitude": lon, "timezone": TZ,
        "daily": daily, "forecast_days": forecast_days, "past_days": past_days
    }
    js = http_get_json("https://api.open-meteo.com/v1/forecast", params=params, timeout=40, retries=4, backoff=1.5, debug=debug)
    if js is None or "daily" not in js:
        return None, None
    idx = pd.to_datetime(js["daily"]["time"])
    d = js["daily"]
    def G(k):
        v=d.get(k); 
        return v if v is not None else [None]*len(idx)
    df = pd.DataFrame({
        "NWP_TMAX": G("temperature_2m_max"),
        "NWP_TMIN": G("temperature_2m_min"),
        "NWP_PPRB_MAX": G("precipitation_probability_max"),
        "NWP_PRCP_MM": G("precipitation_sum"),
        "NWP_PHOURS": G("precipitation_hours"),
        "NWP_SW_RAD_SUM": G("shortwave_radiation_sum"),
        "NWP_RAIN_MM": G("rain_sum"),
        "NWP_SNOW_MM": G("snowfall_sum"),
    }, index=idx).sort_index()
    elev = js.get("elevation", None)
    return df, elev

@lru_cache(maxsize=32)
def fetch_era5_daily(lat: float, lon: float, start_date: str, end_date: Optional[str] = None, debug=False):
    if end_date is None: end_date = yesterday().strftime("%Y-%m-%d")
    params = {
        "latitude": lat, "longitude": lon,
        "start_date": start_date, "end_date": end_date,
        "daily": "temperature_2m_max,precipitation_sum",
        "timezone": TZ
    }
    js = http_get_json("https://archive-api.open-meteo.com/v1/era5", params=params, timeout=45, retries=4, backoff=1.5, debug=debug)
    if js is None or "daily" not in js:
        return None
    idx = pd.to_datetime(js["daily"]["time"])
    df = pd.DataFrame({
        "ERA5_TMAX": js["daily"]["temperature_2m_max"],
        "ERA5_PRCP": js["daily"]["precipitation_sum"]
    }, index=idx).sort_index()
    return df

@lru_cache(maxsize=32)
def fetch_nasa_power_daily(lat: float, lon: float, start_date: str, end_date: Optional[str] = None, debug=False):
    """Fetch NASA POWER API daily climate data"""
    if end_date is None: 
        end_date = yesterday().strftime("%Y%m%d")
    else:
        end_date = end_date.replace("-", "")
    
    start_date = start_date.replace("-", "")
    
    params = {
        "parameters": "T2M_MAX,PRECTOTCORR",
        "community": "RE",
        "longitude": lon,
        "latitude": lat,
        "start": start_date,
        "end": end_date,
        "format": "JSON"
    }
    
    url = "https://power.larc.nasa.gov/api/temporal/daily/point"
    js = http_get_json(url, params=params, timeout=60, retries=3, backoff=2.0, debug=debug)
    
    if js is None or "properties" not in js or "parameter" not in js["properties"]:
        return None
    
    params_data = js["properties"]["parameter"]
    
    if "T2M_MAX" not in params_data or "PRECTOTCORR" not in params_data:
        return None
    
    # Parse dates and create dataframe
    tmax_data = params_data["T2M_MAX"]
    prcp_data = params_data["PRECTOTCORR"]
    
    dates = []
    tmax_vals = []
    prcp_vals = []
    
    for date_str, val in tmax_data.items():
        try:
            date_obj = pd.to_datetime(date_str, format="%Y%m%d")
            dates.append(date_obj)
            tmax_vals.append(val if val != -999 else None)
            prcp_vals.append(prcp_data.get(date_str, 0) if prcp_data.get(date_str, -999) != -999 else 0)
        except:
            continue
    
    if not dates:
        return None
    
    df = pd.DataFrame({
        "POWER_TMAX": tmax_vals,
        "POWER_PRCP": prcp_vals
    }, index=pd.DatetimeIndex(dates)).sort_index()
    
    return df


def compute_daily_clim(series: pd.Series, smooth_window: int = 7) -> pd.Series:
    df = pd.DataFrame({"v": pd.to_numeric(series, errors="coerce")}).dropna()
    if df.empty: 
        raise RuntimeError("Insufficient data for climatology.")
    idx = df.index
    fix = [pd.Timestamp(t.year,2,28) if (t.month==2 and t.day==29) else t for t in idx]
    doy = pd.DatetimeIndex(fix).dayofyear
    df["doy"] = doy
    clim = df.groupby("doy")["v"].mean()
    full = pd.Series(index=range(1,367), dtype=float)
    full.update(clim)
    if not np.isfinite(full.loc[366]): full.loc[366] = full.loc[365]
    if smooth_window and smooth_window>1:
        full = full.rolling(smooth_window, center=True, min_periods=1).mean()
    return full

def same_day_climo_value(clim_by_doy: pd.Series, t: pd.Timestamp, day_window: int = 0) -> float:
    doy = t.dayofyear if not (t.month==2 and t.day==29) else 59
    if day_window<=0:
        return float(clim_by_doy.get(doy, np.nan))
    vals=[]
    for off in range(-day_window, day_window+1):
        k = doy + off
        if k<1: k += 366
        if k>366: k -= 366
        v = float(clim_by_doy.get(k, np.nan))
        if np.isfinite(v): vals.append(v)
    if not vals: 
        return float(clim_by_doy.get(doy, np.nan))
    return float(np.mean(vals))

def warming_offset(idx: pd.DatetimeIndex, per_decade=0.3, baseline_year=2020.5):
    per_year=float(per_decade)/10.0
    years_frac=idx.year+(idx.dayofyear/365.25)
    return pd.Series((years_frac-baseline_year)*per_year, index=idx, dtype=float)

def slope_caps_by_month(ts: pd.Series) -> pd.Series:
    df=pd.DataFrame({"v":pd.to_numeric(ts, errors="coerce")}).dropna()
    if df.empty: return pd.Series(5.0, index=range(1,13), dtype=float)
    df["m"]=df.index.month; df["d"]=df["v"].diff().abs()
    caps=df.groupby("m")["d"].quantile(0.90).clip(lower=2.0, upper=8.0)
    out=pd.Series(5.0, index=range(1,13), dtype=float); out.update(caps); return out

def apply_slope_cap(prev_val: float, candidate: float, cap: float, k=1.0) -> float:
    delta=float(candidate-prev_val); lim=cap*float(k)
    return candidate if abs(delta)<=lim else prev_val+math.copysign(lim, delta)

def _mm_to_prob(mm: float, k: float = 0.9) -> int:
    mm = max(0.0, float(mm))
    p = 100.0 * (1.0 - math.exp(-mm / max(0.05, k)))
    return int(min(100, max(0, round(p))))

def infer_precip_type(mm: float,
                      tmax: Optional[float]=None,
                      rain_mm: Optional[float]=None,
                      snow_mm: Optional[float]=None) -> str:
    """Return 'none' | 'rain' | 'snow' | 'sleet'"""
    mm = 0.0 if mm is None else float(mm)
    if mm < 0.1:
        return "none"

    r = float(rain_mm) if (rain_mm is not None and np.isfinite(rain_mm)) else None
    s = float(snow_mm) if (snow_mm is not None and np.isfinite(snow_mm)) else None
    if (r is not None) or (s is not None):
        r = 0.0 if r is None else r
        s = 0.0 if s is None else s
        if s >= 1.0 and r < 0.5:
            return "snow"
        if r >= 0.5 and s < 1.0:
            return "rain"
        if r >= 0.5 and s >= 1.0:
            return "sleet"

    if tmax is not None and np.isfinite(tmax):
        if tmax <= 1.5:
            return "snow"
        if tmax < 3.5:
            return "sleet"
        return "rain"

    return "rain"

def forecast_core(lat: float, lon: float, horizon_days: int, debug: bool=False, emit_components: bool=False):
    H = int(max(1, min(horizon_days, 540)))

    # Fetch both ERA5 and NASA POWER data
    era = fetch_era5_daily(lat, lon, start_date="2015-01-01", debug=debug)
    power = fetch_nasa_power_daily(lat, lon, start_date="2015-01-01", debug=debug)
    
    # Use ensemble approach: prefer ERA5 but blend with POWER if available
    if era is None or era.empty:
        if power is None or power.empty:
            raise RuntimeError("Neither ERA5 nor NASA POWER data available.")
        # Use only POWER data
        tmax_hist = pd.to_numeric(power["POWER_TMAX"], errors="coerce")
        prcp_hist = pd.to_numeric(power["POWER_PRCP"], errors="coerce").fillna(0.0)
        data_source = "NASA POWER only"
    elif power is not None and not power.empty:
        # Blend both sources for better accuracy
        era_tmax = pd.to_numeric(era["ERA5_TMAX"], errors="coerce")
        power_tmax = pd.to_numeric(power["POWER_TMAX"], errors="coerce")
        
        # Merge on common dates
        combined = pd.concat([era_tmax, power_tmax], axis=1, join='outer')
        combined.columns = ['era', 'power']
        
        # Ensemble: average where both available, otherwise use available source
        tmax_hist = combined.apply(
            lambda row: (0.5 * row['era'] + 0.5 * row['power']) if pd.notna(row['era']) and pd.notna(row['power'])
                        else (row['era'] if pd.notna(row['era']) else row['power']),
            axis=1
        )
        
        # Same for precipitation
        era_prcp = pd.to_numeric(era["ERA5_PRCP"], errors="coerce").fillna(0.0)
        power_prcp = pd.to_numeric(power["POWER_PRCP"], errors="coerce").fillna(0.0)
        combined_prcp = pd.concat([era_prcp, power_prcp], axis=1, join='outer')
        combined_prcp.columns = ['era', 'power']
        prcp_hist = combined_prcp.apply(
            lambda row: (0.5 * row['era'] + 0.5 * row['power']) if row['era'] > 0 and row['power'] > 0
                        else max(row['era'], row['power']),
            axis=1
        )
        data_source = "ERA5 + NASA POWER ensemble"
    else:
        # Use only ERA5
        tmax_hist = pd.to_numeric(era["ERA5_TMAX"], errors="coerce")
        prcp_hist = pd.to_numeric(era["ERA5_PRCP"], errors="coerce").fillna(0.0)
        data_source = "ERA5 only"
    
    if len(tmax_hist.dropna()) < 120:
        raise RuntimeError("Historical data insufficient.")


    clim_tmax = compute_daily_clim(tmax_hist, smooth_window=7)
    clim_prcp = compute_daily_clim(prcp_hist, smooth_window=7)

    end = tmax_hist.index.max()
    recent = tmax_hist.loc[end - pd.Timedelta(days=60): end]
    recent_clim = pd.Series([same_day_climo_value(clim_tmax, t, 0) for t in recent.index], index=recent.index)
    an = float((recent - recent_clim).dropna().tail(30).mean()) if len(recent.dropna()) else 0.0

    fut_idx = pd.date_range(tmax_hist.index.max()+pd.Timedelta(days=1), periods=H, freq="D")
    k = np.arange(1, len(fut_idx)+1, dtype=float)

    base_tmax = pd.Series([same_day_climo_value(clim_tmax, t, 0) for t in fut_idx], index=fut_idx)
    base_tmax = base_tmax + (an*(0.985**(k-1))) + warming_offset(fut_idx, per_decade=0.3, baseline_year=2020.5)

    nwp, _ = fetch_openmeteo_daily(lat, lon, forecast_days=min(16,H), past_days=0, debug=debug)

    caps = slope_caps_by_month(tmax_hist)
    prev_val = float(tmax_hist.dropna().iloc[-1])

    rows=[]
    for i, t in enumerate(fut_idx, start=1):
        if i <= 15 and nwp is not None and (t in nwp.index):
            v = safe_float(nwp.at[t, "NWP_TMAX"])
            if v is not None and np.isfinite(v):
                tmax_val = float(v)
                source = "open-meteo-direct"
            else:
                tmax_val = float(base_tmax.loc[t]); source="blend"
        else:
            model_val = float(base_tmax.loc[t])
            if i == 16 and nwp is not None and (t in nwp.index):
                nv = safe_float(nwp.at[t, "NWP_TMAX"])
                if nv is not None and np.isfinite(nv):
                    model_val = float(0.15*model_val + 0.85*nv)
            cap = float(caps.get(t.month, 5.0))
            tmax_val = float(apply_slope_cap(prev_val, model_val, cap, k=1.1))
            source="blend"
        prev_val = tmax_val

        if nwp is not None and (t in nwp.index):
            mm_nwp = safe_float(nwp.at[t, "NWP_PRCP_MM"]) or 0.0
            p_nwp = safe_float(nwp.at[t, "NWP_PPRB_MAX"])
            mm_clim = float(max(0.0, same_day_climo_value(clim_prcp, t, 1)))
            mm = float(0.6*mm_nwp + 0.4*mm_clim)
            if p_nwp is None or not np.isfinite(p_nwp):
                p = _mm_to_prob(mm, k=0.8)
            else:
                p = int(np.clip(round(0.6*p_nwp + 0.4*_mm_to_prob(mm, k=0.8)), 0, 100))
            rain_nwp = safe_float(nwp.at[t, "NWP_RAIN_MM"]) if "NWP_RAIN_MM" in nwp.columns else None
            snow_nwp = safe_float(nwp.at[t, "NWP_SNOW_MM"]) if "NWP_SNOW_MM" in nwp.columns else None
        else:
            mm = float(max(0.0, same_day_climo_value(clim_prcp, t, 1)))
            p = _mm_to_prob(mm, k=0.9)
            rain_nwp = None; snow_nwp = None

        ptype = infer_precip_type(mm=mm, tmax=tmax_val, rain_mm=rain_nwp, snow_mm=snow_nwp)

        row = {
            "date": t.strftime("%Y-%m-%d"),
            "tmax": float(round(tmax_val, 2)),
            "tmax_source": source,
            "precip_mm": float(round(mm, 2)),
            "precip_prob": int(p),
            "precip_type": ptype
        }

        if emit_components:
            row.update({
                "tmax_model": float(round(float(base_tmax.loc[t]), 2)),
                "tmax_climo": float(round(same_day_climo_value(clim_tmax, t, 0), 2)),
                "tmax_w_model": 1.0 if (i <= 15 and source == "open-meteo-direct") else 0.0,
                "tmax_daywin": 0,
                "tuned_bucket": "direct_0-15" if i <= 15 and source == "open-meteo-direct" else "blend"
            })

        rows.append(row)

    out = {
        "meta": {
            "version": VERSION,
            "timestamp": iso_utc_now(),
            "location": {"lat": float(lat), "lon": float(lon)},
            "sources": ["Open-Meteo Forecast API", "Open-Meteo ERA5 Archive", "NASA POWER API"],
            "data_source": data_source
        },
        "daily": rows
    }
    return out, rows


def build_parser():
    ap = argparse.ArgumentParser(
        prog="nova_logic",
        description="Minimal daily Tmax forecast service (first 15d direct Open-Meteo, then climo/anomaly blend)."
    )
    ap.add_argument("--lat", type=float, required=True, help="Latitude")
    ap.add_argument("--lon", type=float, required=True, help="Longitude")
    ap.add_argument("--horizon-days", type=int, default=360, help="Forecast length in days (<=540)")
    ap.add_argument("--emit-components", action="store_true", help="Include internal fields for debugging")
    ap.add_argument("--out-json", type=str, default=None, help="Write JSON output to file")
    ap.add_argument("--export-csv", nargs="?", const="forecast_out.csv", default=None, help="Also write CSV")
    ap.add_argument("--print-table", action="store_true", help="Pretty-print table")
    ap.add_argument("--debug", action="store_true")
    return ap

def main():
    args = build_parser().parse_args()
    print(f"{VERSION} | nova_logic.py")

    try:
        out, rows = forecast_core(
            args.lat, args.lon, args.horizon_days,
            debug=args.debug, emit_components=args.emit_components
        )
        txt=json.dumps(out, ensure_ascii=False, indent=2)
        print(txt)
        if args.out_json:
            with open(args.out_json, "w", encoding="utf-8") as f: f.write(txt + "\n")
        if args.export_csv:
            pd.DataFrame(rows).to_csv(args.export_csv, index=False)
        if args.print_table:
            print(pd.DataFrame(rows).to_string(index=False))
    except Exception as e:
        print("error:", e.__class__.__name__, "-", str(e))
        if args.debug:
            import traceback; traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    main()
    
