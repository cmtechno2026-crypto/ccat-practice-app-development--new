#!/bin/sh
# Inject the Gateway base URL at container start (12-factor). index.html must load /config.js.
: "${CCAT_GATEWAY_URL:?set CCAT_GATEWAY_URL, e.g. https://api.conceptmastery.ca}"
printf 'window.__CCAT_GATEWAY__=%s;\n' "\"$CCAT_GATEWAY_URL\"" > /usr/share/nginx/html/config.js
