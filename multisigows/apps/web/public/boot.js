// Loading-state helper. External on purpose: the site's CSP (script-src 'self') allows no inline script.
// If the app has not replaced the splash after 10 seconds, say so and offer a reload.
(function () {
  setTimeout(function () {
    var slow = document.getElementById('boot-slow');
    if (slow) slow.classList.add('is-visible');
  }, 10000);
  var reload = document.getElementById('boot-reload');
  if (reload) {
    reload.addEventListener('click', function () {
      location.reload();
    });
  }
})();
