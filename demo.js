// Pause the hero loop while it is off screen.
(() => {
  const demo = document.getElementById("demo");
  if (!demo || !("IntersectionObserver" in window)) return;
  new IntersectionObserver(([e]) => demo.classList.toggle("paused", !e.isIntersecting)).observe(demo);
})();
