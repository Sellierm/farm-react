# Farm React

Farm React is a farm management web app.

It lets users:

- view forecast and Sencrop weather data,
- display fields on a map,
- track GPS positions/history of machines,

## GPS source

GPS data is sent by the **gps-sender** repository to this project's endpoint:

- Repository: [https://github.com/Sellierm/gps-sender](https://github.com/Sellierm/gps-sender)

- `POST /api/location`

## `server/.env.example`

Copy `server/.env.example` to `server/.env` and fill in the values.

What each group is used for:

- `NODE_ENV`, `PORT`, `IP`: server runtime and listening address.
- `CORS_ORIGINS`: allowed frontend origins for API calls.
- `SESSION_SECRET`: session and CSRF security secret.
- `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_DATABASE`: MySQL connection.
- `GPS_INGEST_KEY`, `GPS_ALLOWED_IDS`: authorize GPS devices sending locations.
- `GOOGLE_MAPS_API_KEY`: Google Maps display on the Fields page.
- `OPENWEATHER_API_KEY`, `FORECAST_LATITUDE`, `FORECAST_LONGITUDE`, `FORECAST_CITY`: weather forecast data.
- `SENCROP_*`: Sencrop API credentials and device identifiers.
