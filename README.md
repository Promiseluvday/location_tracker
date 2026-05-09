# Rider Location Prototype

This prototype captures a rider's browser GPS location after the rider grants permission, sends live updates about every 30 seconds while the page is open, stores the latest location in the backend, and exposes lookup endpoints your WhatsApp bot can call.

## Run locally

```bash
cd backend
npm install
npm start
```

Open `frontend/index.html` in a browser and set `API_BASE_URL` to your deployed backend URL before going live.

Browser geolocation works on `localhost` during development. In production, the frontend must be served over HTTPS.

## API

Save a rider location:

```http
POST /api/location
Content-Type: application/json

{
  "riderId": "RIDER-001",
  "orderId": "ORDER-1234",
  "latitude": 6.5244,
  "longitude": 3.3792,
  "accuracy": 18
}
```

Query one order/rider pair:

```http
GET /api/location/ORDER-1234/RIDER-001
```

Query the latest location for one rider:

```http
GET /api/rider/RIDER-001/location
```

Query all latest rider locations for dispatch matching:

```http
GET /api/riders/locations
```

Query the latest rider location attached to an order:

```http
GET /api/order/ORDER-1234/location
```

Query bike GPS tracker locations from Cantrack:

```http
GET /api/cantrack/locations
```

The response includes latitude, longitude, accuracy, a Google Maps URL, and an address when reverse geocoding is available.

## Cantrack environment variables

Set these on Render to enable the Cantrack endpoints:

```env
CANTRACK_USER=your-cantrack-username
CANTRACK_PASS=your-cantrack-password
CANTRACK_SCHOOL_ID=your-school-id
CANTRACK_CUST_ID=your-customer-id
CANTRACK_TRACKER_IDS=device-id-1,device-id-2,device-id-3
```

The Cantrack integration logs in through the current portal flow and uses the fresh MDS token returned by Cantrack, then queries `TrackService.aspx` for the configured tracker IDs.

## Production notes

- Get clear rider consent before collecting location.
- Use HTTPS for the rider page.
- Replace the in-memory `Map` with a database before production.
- Protect the WhatsApp lookup endpoint with authentication before sharing it publicly.
- GPS accuracy depends on the rider's device, signal, and browser permission. Treat the address as an approximate reverse-geocoded address, not a guaranteed exact address.
