type LocationFix = { coords: { latitude: number; longitude: number; accuracy: number } };

// Called only after the user taps Use my location; never watch in the background.
export async function currentLocation(): Promise<LocationFix> {
  if (import.meta.env.MODE === "native") {
    const { Geolocation } = await import("@capacitor/geolocation");
    return Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
  }
  if (!navigator.geolocation || !window.isSecureContext) throw new Error("Geolocation unavailable");
  return new Promise((resolve,reject) => navigator.geolocation.getCurrentPosition(resolve,reject,
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }));
}
