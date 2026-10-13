import '@testing-library/jest-dom/vitest';

// jsdom does not implement scrolling; route changes call it.
window.scrollTo = (() => undefined) as typeof window.scrollTo;
