// Export the ride as a TCX file (accepted by Strava, Garmin Connect, TrainingPeaks, ...).

export function buildTcx(samples, startDate, route) {
  const iso = (ms) => new Date(ms).toISOString();
  const t0 = startDate.getTime();
  const last = samples[samples.length - 1];
  const points = samples
    .map((s) => {
      const { lat, lon } = route.latLon(s.x, s.z);
      return `<Trackpoint><Time>${iso(t0 + s.wall * 1000)}</Time><Position><LatitudeDegrees>${lat.toFixed(6)}</LatitudeDegrees><LongitudeDegrees>${lon.toFixed(6)}</LongitudeDegrees></Position><AltitudeMeters>${s.ele.toFixed(1)}</AltitudeMeters><DistanceMeters>${s.ridden.toFixed(1)}</DistanceMeters>${
        s.hr ? `<HeartRateBpm><Value>${Math.round(s.hr)}</Value></HeartRateBpm>` : ''
      }<Cadence>${Math.round(s.cadence)}</Cadence><Extensions><TPX xmlns="http://www.garmin.com/xmlschemas/ActivityExtension/v2"><Speed>${s.speed.toFixed(2)}</Speed><Watts>${Math.round(s.power)}</Watts></TPX></Extensions></Trackpoint>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
<Activities><Activity Sport="Biking"><Id>${iso(t0)}</Id>
<Lap StartTime="${iso(t0)}"><TotalTimeSeconds>${last ? last.wall.toFixed(0) : 0}</TotalTimeSeconds><DistanceMeters>${last ? last.ridden.toFixed(1) : 0}</DistanceMeters><Intensity>Active</Intensity><TriggerMethod>Manual</TriggerMethod>
<Track>
${points}
</Track></Lap>
<Notes>${route.name} (virtual ride)</Notes>
</Activity></Activities>
</TrainingCenterDatabase>`;
}

export function download(filename, text, type = 'application/vnd.garmin.tcx+xml') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
