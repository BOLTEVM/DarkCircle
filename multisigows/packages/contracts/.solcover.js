module.exports = {
  // json-summary feeds scripts/check-coverage.js; lcov/text are for humans.
  istanbulReporter: ["json-summary", "lcov", "text"],
  skipFiles: ["test/"],
};
