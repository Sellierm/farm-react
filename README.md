# Farm React

Farm React is a farm management web app.

It lets users:

- view forecast (OpenWeatherMap) and Sencrop weather data,
- display fields on a map,
- track GPS positions/history of machines,

## Getting Started / Implementation

To start using this project, you need to create your own configuration files and obtain required API keys from external services.

### 1. Environment variables (`server/.env.example`)

Copy `server/.env.example` to `server/.env` and fill in the values.

What each group is used for:

- `NODE_ENV`, `PORT`, `IP`: server runtime and listening address.
- `CORS_ORIGINS`: allowed frontend origins for API calls.
- `SESSION_SECRET`: session and CSRF security secret.
- `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_DATABASE`: MySQL connection.
- `GPS_INGEST_KEY`, `GPS_ALLOWED_IDS`: authorize GPS devices sending locations (should be the same in gps-sender).
- `GOOGLE_MAPS_API_KEY`: Google Maps display on the Fields page. You must generate it from the [Google Cloud Console](https://console.cloud.google.com/) (Maps JavaScript API).
- `OPENWEATHER_API_KEY`, `FORECAST_LATITUDE`, `FORECAST_LONGITUDE`, `FORECAST_CITY`: weather forecast data. Create an account on [OpenWeatherMap](https://openweathermap.org/) to get your API key.
- `SENCROP_*`: Sencrop API credentials and device identifiers. To learn how to get your Sencrop API keys, refer to their [API workflow for users](https://observablehq.com/@57ac0233e9966902/api-workflow-for-users).

### 2. Custom Maps module (`server/modules/mapModule.js`)

Create a file at `server/modules/mapModule.js` based on your [Google My Maps](https://www.google.com/maps/d/):

```javascript
module.exports = {
  key: process.env.GOOGLE_MAPS_API_KEY,
  table: [
    // Layer mapping (Year / Crop configuration mapping your KMLs)
    "https://www.google.com/maps/d/kml?forcekml=1&mid=YOUR_MAP_ID&lid=YOUR_LAYER_ID",
    "https://www.google.com/maps/d/kml?forcekml=1&mid=YOUR_MAP_ID&lid=YOUR_LAYER_ID",
    "https://www.google.com/maps/d/kml?forcekml=1&mid=YOUR_MAP_ID&lid=YOUR_LAYER_ID",
    // Add as many layers as needed matching your frontend logic
  ],
};
```

_Note: To extract KML links, open your custom map in Google My Maps, click on the three dots next to a layer -> "Export data" -> KML, and observe the download URL._

### 3. MySQL Database (Structure)

The project relies on a MySQL database containing the following tables. You must create them on your server:

```sql
CREATE TABLE `user` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `password` varchar(255) NOT NULL, -- Password hashed by bcrypt
  PRIMARY KEY (`id`)
);

CREATE TABLE `vehicles` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `type` varchar(255) DEFAULT NULL,
  `brand` varchar(255) DEFAULT NULL,
  `model` varchar(255) DEFAULT NULL,
  `year` int(4) DEFAULT NULL,
  `plate` varchar(50) DEFAULT NULL,
  `hours` float DEFAULT 0,
  PRIMARY KEY (`id`)
);

CREATE TABLE `maintenance` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `vehicle_id` int(11) NOT NULL,
  `type` varchar(255) NOT NULL,
  `date` date NOT NULL,
  `hours_at_service` float DEFAULT NULL,
  `next_date` date DEFAULT NULL,
  `next_hours` float DEFAULT NULL,
  `notes` text DEFAULT NULL,
  PRIMARY KEY (`id`),
  FOREIGN KEY (`vehicle_id`) REFERENCES `vehicles`(`id`) ON DELETE CASCADE
);

/* The following tables are required for the Phyto module */
CREATE TABLE `phyto_products` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `category` varchar(255) NOT NULL,
  `unit` varchar(50) NOT NULL,
  `stock` float DEFAULT 0,
  `notes` text DEFAULT NULL,
  PRIMARY KEY (`id`)
);

CREATE TABLE `phyto_applications` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `product_id` int(11) NOT NULL,
  `date` date NOT NULL,
  `field` varchar(255) NOT NULL,
  `quantity` float NOT NULL,
  `notes` text DEFAULT NULL,
  PRIMARY KEY (`id`),
  FOREIGN KEY (`product_id`) REFERENCES `phyto_products`(`id`) ON DELETE CASCADE
);
```

## GPS source

GPS data is sent by the **gps-sender** repository to this project's endpoint:

- Repository: [https://github.com/Sellierm/gps-sender](https://github.com/Sellierm/gps-sender)
- `POST /api/location`
