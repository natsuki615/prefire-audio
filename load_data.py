import earthaccess
import xarray as xr

# 1. Authenticate with your NASA Earthdata credentials
auth = earthaccess.login(strategy="interactive")

# 2. Query a specific satellite track from a single day (e.g., Surface Emissivity)
# Change the short_name to 'PREFIRE_SAT1_1B-RAD' if you want raw radiance wavelengths instead
results = earthaccess.search_data(
    short_name="PREFIRE_SAT1_2B-SFC",
    cloud_hosted=True,
    temporal=("2025-01-01", "2025-01-02")
)

# 3. Download the first file chunk (a single orbital path sweep)
downloaded_files = earthaccess.download(results[0:1], local_path="./data")

# 4. Open it as a linear sequential dataset
ds = xr.open_dataset(downloaded_files[0])

# 5. Extract your sequential track variables
timestamps = ds['time'].values
latitudes = ds['lat'].values
longitudes = ds['lon'].values
emissivity = ds['surface_emissivity'].values  # Your primary player data source!

print(f"Loaded a track player loop with {len(timestamps)} chronological steps!")
