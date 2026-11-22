// postready.<account>.workers.dev: a second address for the same app.
// Every request is handed to the main Worker, so both addresses share one
// deployment, one quota store and one set of saved videos.
export default { fetch: (request, env) => env.APP.fetch(request) };
