self.addEventListener('fetch', function (event) {
  event.respondWith(
    fetch(event.request).catch(err => {
      console.error('SW fetch error:', err);
      return new Response("Offline or error", {
        status: 503,
        statusText: "Service Unavailable"
      });
    })
  );
});
