const express = require("express");
const cors = require("cors");
const app = express();

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.includes("*") ? "*" : allowedOrigins,
  })
);
app.use(express.json());

const latestLocations = new Map();
const latestLocationsByRider = new Map();
const latestLocationsByOrder = new Map();

function normalizeId(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 64);
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function buildGoogleMapsUrl(latitude, longitude) {
  return `https://www.google.com/maps?q=${latitude},${longitude}`;
}

async function reverseGeocode(latitude, longitude) {
  if (process.env.DISABLE_REVERSE_GEOCODING === "true") {
    return null;
  }

  const response = await fetch(
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(
      latitude
    )}&lon=${encodeURIComponent(longitude)}`
  );

  if (!response.ok) {
    return null;
  }

  const data = await response.json();
  return data.display_name || null;
}

app.post("/api/location", async (req, res) => {
  const riderId = normalizeId(req.body.riderId);
  const orderId = normalizeId(req.body.orderId);
  const latitude = toNumber(req.body.latitude);
  const longitude = toNumber(req.body.longitude);
  const accuracy = toNumber(req.body.accuracy);

  if (!riderId) {
    return res.status(400).json({
      success: false,
      message: "riderId is required.",
    });
  }

  if (
    latitude === null ||
    longitude === null ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return res.status(400).json({
      success: false,
      message: "Valid latitude and longitude are required.",
    });
  }

  let address = null;
  try {
    address = await reverseGeocode(latitude, longitude);
  } catch (error) {
    console.warn("Reverse geocoding failed:", error.message);
  }

  const location = {
    riderId,
    orderId: orderId || null,
    latitude,
    longitude,
    accuracy,
    address,
    mapUrl: buildGoogleMapsUrl(latitude, longitude),
    sharedAt: new Date().toISOString(),
  };

  latestLocationsByRider.set(riderId, location);
  if (orderId) {
    latestLocations.set(`${orderId}:${riderId}`, location);
    latestLocationsByOrder.set(orderId, location);
  }

  console.log("Consented rider location received:", location);
  res.json({ success: true, location });
});

app.get("/api/riders/locations", (req, res) => {
  const locations = [...latestLocationsByRider.values()].map((location) => ({
    ...location,
    ageSeconds: Math.round((Date.now() - Date.parse(location.sharedAt)) / 1000),
  }));

  res.json({ success: true, count: locations.length, locations });
});

app.get("/api/rider/:riderId/location", (req, res) => {
  const riderId = normalizeId(req.params.riderId);
  const location = latestLocationsByRider.get(riderId);

  if (!location) {
    return res.status(404).json({
      success: false,
      message: "No location has been shared for this rider yet.",
    });
  }

  res.json({
    success: true,
    location: {
      ...location,
      ageSeconds: Math.round((Date.now() - Date.parse(location.sharedAt)) / 1000),
    },
  });
});

app.get("/api/order/:orderId/location", (req, res) => {
  const orderId = normalizeId(req.params.orderId);
  const location = latestLocationsByOrder.get(orderId);

  if (!location) {
    return res.status(404).json({
      success: false,
      message: "No rider location has been shared for this order yet.",
    });
  }

  res.json({
    success: true,
    location: {
      ...location,
      ageSeconds: Math.round((Date.now() - Date.parse(location.sharedAt)) / 1000),
    },
  });
});

app.get("/api/location/:orderId/:riderId", (req, res) => {
  const orderId = normalizeId(req.params.orderId);
  const riderId = normalizeId(req.params.riderId);
  const location = latestLocations.get(`${orderId}:${riderId}`);

  if (!location) {
    return res.status(404).json({
      success: false,
      message: "No location has been shared for this rider and order yet.",
    });
  }

  res.json({ success: true, location });
});

app.get("/", (req, res) => {
  res.send("Liebe Tag rider location API is running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
