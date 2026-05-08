# Rider Location Prototype

This prototype captures a rider's current browser GPS location after the rider grants permission, stores the latest location in the backend, and exposes a lookup endpoint your WhatsApp bot can call.

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

Query the latest location for WhatsApp:

```http
GET /api/location/ORDER-1234/RIDER-001
```

The response includes latitude, longitude, accuracy, a Google Maps URL, and an address when reverse geocoding is available.

## Production notes

- Get clear rider consent before collecting location.
- Use HTTPS for the rider page.
- Replace the in-memory `Map` with a database before production.
- Protect the WhatsApp lookup endpoint with authentication before sharing it publicly.
- GPS accuracy depends on the rider's device, signal, and browser permission. Treat the address as an approximate reverse-geocoded address, not a guaranteed exact address.
