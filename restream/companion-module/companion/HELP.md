## ISU Restream

Controls **Restream** (Kate / Kagejitsu, in `restream/` of ISU-Esports-Broadcast-Control) from Companion.

**Setup in Restream:** Control tab → tick *Enable the control API* (port 3181), copy the key. Companion on another PC: also tick *Allow other PCs*.

**Setup here:** host = Restream PC IP (127.0.0.1 on the same PC), port, key.

**Actions:** Go Live, Stop (plays out the delay buffer), CUT (discards it), recording on/off/toggle, audio monitor on/off/toggle, program gain set / ±, monitor volume set / ±.

**Variables:** state, on_air, delay_filled_seconds / delay_seconds, on_air_in_seconds, recording, recording_seconds, gain_db, monitor, monitor_volume_db, audio peaks, fps / kbps, error, outN_name / outN_state / outN_live / outN_kbps / outN_reconnects (destinations 1-8 in Restream's order).

The CUT preset fires only after holding the button 1 second.
