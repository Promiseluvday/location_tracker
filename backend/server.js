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
const cantrackState = {
  cookies: new Map(),
  mds: "",
  lastLoginAt: 0,
};
const DEFAULT_CANTRACK_TRACKER_IDS = [
  "ec86025d2be54efb96634bd437c56e23",
  "791b7b56bacf4b84a8ff4e7a9c82309a",
  "320cee40e50c441cb3b0e72b11c5692e",
  "f59bbda3b8104ec5b4cafaf740e6e3ce",
  "c35c83a5e069496a80b0e1d3f1878062",
];

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

function getCantrackConfig() {
  const trackerIds = (process.env.CANTRACK_TRACKER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  return {
    baseUrl: process.env.CANTRACK_BASE_URL || "https://www.cantrackportal.com",
    user: process.env.CANTRACK_USER || "",
    pass: process.env.CANTRACK_PASS || "",
    schoolId: process.env.CANTRACK_SCHOOL_ID || "",
    custId: process.env.CANTRACK_CUST_ID || process.env.CANTRACK_SCHOOL_ID || "",
    trackerIds: trackerIds.length ? trackerIds : DEFAULT_CANTRACK_TRACKER_IDS,
    trackerIdsFromEnv: trackerIds.length > 0,
  };
}

function cookieHeader() {
  const cookies = [...cantrackState.cookies.entries()].map(
    ([name, value]) => `${name}=${value}`
  );
  cookies.push("domainIndex=0");
  return cookies.join("; ");
}

function storeCookies(headers) {
  const raw = headers.get("set-cookie") || "";
  const parts = raw.split(/,(?=[^ ;]+=)/).map((value) => value.trim()).filter(Boolean);

  for (const part of parts) {
    const [nameValue] = part.split(";");
    const separator = nameValue.indexOf("=");
    if (separator > 0) {
      cantrackState.cookies.set(
        nameValue.slice(0, separator),
        nameValue.slice(separator + 1)
      );
    }
  }
}

function extractLocationHref(text) {
  const match = text.match(/(?:window\.)?location\.href\s*=\s*["']([^"']+)/i);
  return match ? match[1] : "";
}

function absoluteCantrackUrl(path, baseUrl) {
  return path.startsWith("http") ? path : `${baseUrl}${path}`;
}

function looksLikeCantrackLogout(text) {
  const normalized = text.trim().toLowerCase();
  return (
    normalized.includes("logout.aspx") ||
    normalized.includes("loginouts") ||
    normalized.startsWith("<!doctype") ||
    normalized.startsWith("<html")
  );
}

async function cantrackRequest(path, options = {}) {
  const { baseUrl } = getCantrackConfig();
  const response = await fetch(absoluteCantrackUrl(path, baseUrl), {
    method: options.method || "GET",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
      Referer: options.referer || `${baseUrl}/Skins/DefaultIndex/`,
      Cookie: cookieHeader(),
      ...(options.headers || {}),
    },
    body: options.body,
    redirect: "manual",
  });

  storeCookies(response.headers);
  return {
    response,
    text: await response.text(),
  };
}

async function loginCantrack() {
  const config = getCantrackConfig();
  if (!config.user || !config.pass || !config.schoolId || !config.custId) {
    throw new Error(
      "Set CANTRACK_USER, CANTRACK_PASS, CANTRACK_SCHOOL_ID, and CANTRACK_CUST_ID."
    );
  }

  cantrackState.cookies.clear();
  await cantrackRequest("/Skins/DefaultIndex/");

  const body = new URLSearchParams({
    userName: config.user,
    pwd: config.pass,
    monitor: "0",
    loginType: "ENTERPRISE",
    url: "",
    rand: "",
    language: "en",
    timeZone: "1",
  });

  const login = await cantrackRequest("/LoginByUser.aspx?method=loginSystem", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const sendRedirectPath = extractLocationHref(login.text);
  if (!sendRedirectPath) {
    throw new Error("Cantrack login did not return a redirect.");
  }

  const redirect = await cantrackRequest(sendRedirectPath, {
    referer: `${config.baseUrl}/LoginByUser.aspx?method=loginSystem`,
  });

  const indexPath = extractLocationHref(redirect.text);
  if (!indexPath) {
    throw new Error("Cantrack redirect did not return a user index URL.");
  }

  const indexUrl = new URL(absoluteCantrackUrl(indexPath, config.baseUrl));
  cantrackState.mds = indexUrl.searchParams.get("mds") || "";
  cantrackState.lastLoginAt = Date.now();

  await cantrackRequest(indexPath, {
    referer: absoluteCantrackUrl(sendRedirectPath, config.baseUrl),
  });

  if (!cantrackState.mds) {
    throw new Error("Cantrack did not return a fresh MDS token.");
  }
}

function parseCantrackRecord(record) {
  if (!Array.isArray(record) || record.length < 11) {
    return null;
  }

  const longitude = Number(record[1]);
  const latitude = Number(record[2]);
  if (!latitude && !longitude) {
    return null;
  }

  return {
    deviceId: String(record[10] || ""),
    latitude,
    longitude,
    speedKmh: Number(record[7] || 0),
    heading: Number(record[9] || 0),
    timestamp: record[5] ? new Date(Number(record[5])).toISOString() : new Date().toISOString(),
    mapUrl: buildGoogleMapsUrl(latitude, longitude),
  };
}

async function fetchCantrackLocations() {
  const config = getCantrackConfig();
  if (!config.trackerIds.length) {
    throw new Error("Set CANTRACK_TRACKER_IDS as comma-separated device IDs.");
  }

  if (!cantrackState.mds || Date.now() - cantrackState.lastLoginAt > 20 * 60 * 1000) {
    await loginCantrack();
  }

  const url = new URL(`${config.baseUrl}/TrackService.aspx`);
  url.searchParams.set("method", "getUserAndGPSInfoUtcByIds");
  url.searchParams.set("school_id", config.schoolId);
  url.searchParams.set("custid", config.custId);
  url.searchParams.set("user_ids", config.trackerIds.join(","));
  url.searchParams.set("mapType", "GOOGLE");
  url.searchParams.set("option", "en");
  url.searchParams.set("Selected", "device");
  url.searchParams.set("currentid", config.custId);
  url.searchParams.set("update", "1");
  url.searchParams.set("mds", cantrackState.mds);

  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
      Accept: "text/javascript, application/javascript, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${config.baseUrl}/user/tracking.html?mds=${cantrackState.mds}&school_id=${config.schoolId}&custid=${config.custId}&mapType=GOOGLE`,
      Cookie: cookieHeader(),
    },
  });

  const text = await response.text();
  if (looksLikeCantrackLogout(text)) {
    await loginCantrack();
    return fetchCantrackLocations();
  }

  const data = JSON.parse(text);
  const records = Array.isArray(data.records) ? data.records : [];
  return records.map(parseCantrackRecord).filter(Boolean);
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

app.get("/api/cantrack/locations", async (req, res) => {
  try {
    const locations = await fetchCantrackLocations();
    res.json({
      success: true,
      count: locations.length,
      source: "cantrack",
      locations,
    });
  } catch (error) {
    res.status(502).json({
      success: false,
      message: error.message,
    });
  }
});

app.get("/api/cantrack/config", (req, res) => {
  const config = getCantrackConfig();

  res.json({
    success: true,
    cantrackUserSet: Boolean(config.user),
    cantrackPassSet: Boolean(config.pass),
    schoolIdSet: Boolean(config.schoolId),
    custIdSet: Boolean(config.custId),
    trackerIdsFromEnv: config.trackerIdsFromEnv,
    trackerIdCount: config.trackerIds.length,
    hasFreshMds: Boolean(cantrackState.mds),
    lastLoginAt: cantrackState.lastLoginAt
      ? new Date(cantrackState.lastLoginAt).toISOString()
      : null,
  });
});

app.get("/api/cantrack/location/:deviceId", async (req, res) => {
  try {
    const deviceId = normalizeId(req.params.deviceId);
    const locations = await fetchCantrackLocations();
    const location = locations.find((item) => item.deviceId === deviceId);

    if (!location) {
      return res.status(404).json({
        success: false,
        message: "No Cantrack location found for this device.",
      });
    }

    res.json({ success: true, source: "cantrack", location });
  } catch (error) {
    res.status(502).json({
      success: false,
      message: error.message,
    });
  }
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
