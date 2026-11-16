// Send www.pdc.ax to the apex; everything else is served from static assets.
export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === "www.pdc.ax") {
      url.hostname = "pdc.ax";
      return Response.redirect(url.toString(), 301);
    }
    return env.ASSETS.fetch(request);
  },
};
