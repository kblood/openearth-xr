# Physical-headset release checklist

Browser automation cannot validate stereoscopy, controller mappings, comfort,
runtime frame pacing, or headset-specific WebXR behavior. Complete this checklist
for every release that changes XR rendering, controls, tile selection, scale,
materials, or dependencies.

Record headset, operating-system/runtime, browser version, controller/input
profile, test location, build commit, and date with the result.

## Session and presentation

- [ ] Entry follows a direct user gesture and shows exactly one globe.
- [ ] Exit, headset sleep/wake, browser interruption, and re-entry restore both
      XR and desktop rendering without a stale canvas or duplicate session.
- [ ] Both eyes show matching, correctly oriented geometry with no mirrored text.
- [ ] Near/far clipping, depth precision, lighting, and transparency remain
      stable from orbit through minimum altitude.
- [ ] Floor height is plausible in standing and seated use; unsupported reference
      spaces fail clearly or use the documented fallback.

## Navigation and comfort

- [ ] Each controller's grip, trigger, and stick mapping matches the help text.
- [ ] Single-grip drag anchors terrain without wrist-induced globe rotation.
- [ ] Dual-grip midpoint, twist, pinch, and stretch are stable when either hand
      crosses the other or tracking briefly drops.
- [ ] Turn, pan, fly, and zoom gains remain controllable at orbital, aircraft,
      city, street, and building altitudes.
- [ ] Minimum clearance prevents entering the globe without visible bouncing.
- [ ] The globe-to-local-tangent transition around aircraft altitude has no
      visible jump, flat tile in front of the face, or loss of surrounding map.
- [ ] A ten-minute free-navigation session causes no unexpected acceleration,
      camera roll, nausea-inducing jumps, or loss of control.

## Maps and buildings

- [ ] Country, city, street, and building-scale imagery stays centered on the
      same geographic location through every LOD transition.
- [ ] Labels are readable and not mirrored; nearby context remains populated
      while looking away from the nadir.
- [ ] Fast motion, offline/failing providers, and recovery do not replace good
      coverage with blank atlases or trigger uncontrolled retries.
- [ ] Buildings align with streets, remain above the surface, preserve courtyards,
      and disappear/reappear without leaked meshes or obvious frame spikes.
- [ ] Required OpenStreetMap, CARTO, OpenFreeMap, and OpenMapTiles attribution is
      readable in the immersive presentation.

## Performance evidence

- [ ] Capture average and worst-frame GPU/CPU timing at the five altitude bands.
- [ ] Check memory before entry, after ten minutes of travel, after exit, and
      after re-entry.
- [ ] Record request counts and cancellation/retry behavior during fast travel.
- [ ] Store captures under the ignored `artifacts/` directory and summarize the
      result in the release or pull request.
