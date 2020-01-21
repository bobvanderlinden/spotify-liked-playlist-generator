const express = require("express");
const request = require("request-promise-native");
const opn = require("opn");
const querystring = require("querystring");
const URL = require("url");

function promisify(fn) {
  return function(...args) {
    return new Promise((resolve, reject) => {
      fn.call(this, ...args, (err, result) => {
        if (err) {
          return reject(err);
        }
        resolve(result);
      });
    });
  };
}

function base64Encode(str) {
  return Buffer.from(str).toString("base64");
}

function slices(arr, sliceLength) {
  const remaining = arr.slice(0);
  const result = [];
  while (remaining.length > sliceLength) {
    const slice = remaining.splice(0, sliceLength);
    result.push(slice);
  }
  if (remaining.length > 0) {
    result.push(remaining);
  }
  return result;
}

function wait(milliseconds) {
  console.log(`Waiting for ${milliseconds} milliseconds...`);
  return new Promise((resolve, reject) => {
    setTimeout(resolve, milliseconds);
  });
}

// This function lets the user authenticate using OAuth2 in their browser.
function authenticate({
  clientId,
  clientSecret,
  scopes,
  authenticateUrl,
  tokenUrl,
  httpPort,
  loginPath,
  callbackPath
}) {
  return new Promise(async (resolve, reject) => {
    const redirectUri = `http://127.0.0.1:${httpPort}${callbackPath}`;
    const app = express();

    // Create a endpoint where we can send the browser to, which redirects to the correct
    // authentication URL.
    const tokenResponseBodyPromise = new Promise((resolve, _reject) => {
      app.get(loginPath, (_req, res) => {
        res.redirect(
          authenticateUrl +
            "?" +
            querystring.stringify({
              response_type: "code",
              client_id: clientId,
              scope: scopes.join(" "),
              redirect_uri: redirectUri
            })
        );
        res.end();
      });

      // Create a endpoint for the OAuth2 callback URL.
      // We'll receive the authentication code here as a query parameter.
      app.get(callbackPath, async (req, res) => {
        const code = req.query.code;

        // We received the authentication code.
        // Now we can fetch the actual tokens we need to
        // do furher requests (like 'access_token')
        const responseBody = await request({
          method: "POST",
          url: tokenUrl,
          headers: {
            Authorization: `Basic ${base64Encode(
              `${clientId}:${clientSecret}`
            )}`,
            Accept: "application/json"
          },
          form: {
            grant_type: "authorization_code",
            code: code,
            redirect_uri: redirectUri
          }
        });
        resolve(JSON.parse(responseBody));
        res.end();
      });
    });

    const server = await new Promise((resolve, reject) => {
      const server = app.listen(httpPort, "127.0.0.1", undefined, err => {
        if (err) {
          return reject(err);
        }
        resolve(server);
      });
    });

    opn(`http://127.0.0.1:${httpPort}${loginPath}`);

    const tokenResponseBody = await tokenResponseBodyPromise;

    await promisify(server.close).call(server);

    resolve(tokenResponseBody);
  });
}

function createClient({ urlPrefix, tokenType, token }) {
  return async options => {
    const { method, url, query, body, headers } = options;
    const requestOptions = {
      method: method || "GET",
      url: URL.resolve(urlPrefix, url),
      qs: query,
      json: body,
      headers: {
        Authorization: `${tokenType} ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...headers
      },
      simple: false,
      resolveWithFullResponse: true
    };

    return await attemptRequest();

    async function reattemptRequest() {
      // Always wait at least one second before reattempting another request.
      // We don't want to make the server mad.
      await wait(1000);
      return await attemptRequest();
    }

    async function attemptRequest() {
      let response;
      try {
        response = await request(requestOptions);
      } catch (err) {
        // Some mirrors of Spotify are not always available. Since every request goes
        // through the load balancer, we sometimes run into unavailable servers.
        // Just retry the request.
        if (err.name === "RequestError" && err.cause.code === "ECONNRESET") {
          return await reattemptRequest();
        } else {
          throw err;
        }
      }

      switch (response.statusCode) {
        case 429:
          // When doing too many requests, the Spotify API will respond with 429 and set
          // the 'Retry-After' header to the number of seconds we'll need to wait.
          const retryAfter = parseInt(response.headers["retry-after"], 10) || 1;
          await wait(retryAfter * 1000);
          return await reattemptRequest();
        case 200:
        case 201:
          if (response.body === undefined) {
            // Spotify PUT APIs respond with no body and at the same time status 200.
            return undefined;
          } else if (typeof response.body === 'string') {
            return JSON.parse(response.body);
          } else {
            return response.body
          }
        case 204:
          return null;
        case 502:
          return await reattemptRequest();
        default:
          throw new Error(
            `Invalid status code ${response.statusCode}: ${JSON.stringify(
              response.body
            )}`
          );
      }
    }
  };
}

async function getAllItems(spotifyClient, firstResponse) {
  const items = [...firstResponse.items]
  let previousResponse = firstResponse

  while (previousResponse.next) {
    previousResponse = await spotifyClient({
      method: "GET",
      url: previousResponse.next
    });
    items.push(...previousResponse.items)
  }

  return items
}

async function run() {
  console.log("Authenticating Spotify...");
  const spotifyTokens = await authenticate({
    clientId: "4dda6e4c2539432a993f0a4175b537f2",
    clientSecret: "2a9be6408d1f470f8feec24f20503c00",
    scopes: ["user-library-read", "playlist-modify-private"],
    authenticateUrl: "https://accounts.spotify.com/authorize",
    tokenUrl: "https://accounts.spotify.com/api/token",
    httpPort: 3000,
    loginPath: "/spotify/login",
    callbackPath: "/spotify/callback"
  });

  const spotifyClient = createClient({
    urlPrefix: "https://api.spotify.com",
    tokenType: spotifyTokens.token_type,
    token: spotifyTokens.access_token
  });

  const me = await spotifyClient({
    method: "GET",
    url: "/v1/me"
  })

  console.log(`Logged in as ${me.display_name || me.email} with ID ${me.id}`)

  // Find the Spotify equivalent tracks and store only their ids
  const myLikedTracks = await getAllItems(spotifyClient, await spotifyClient({
    method: "GET",
    url: `/v1/me/tracks`
  }));

  const myTracks = myLikedTracks.map(likedTrack => likedTrack.track)

  console.log(`Fetched all ${myTracks.length} tracks! Creating playlist...`)

  const likedPlaylist = await spotifyClient({
    method: "POST",
    url: `/v1/users/${me.id}/playlists`,
    body: {
      name: `Liked songs (${new Date().toISOString()})`,
      public: false
    }
  })

  console.log(`Created playlist ${likedPlaylist.name} with ID ${likedPlaylist.id}`)

  for (let trackSlice of slices(myTracks, 100)) {
    await spotifyClient({
      method: "POST",
      url: `/v1/playlists/${likedPlaylist.id}/tracks`,
      body: {
        uris: trackSlice.map(track => track.uri)
      }
    })
  }

  console.log(`Added all ${myTracks.length} songs to playlist`)
}

run()
  .then(() => {
    // We finished succesfully, but we'll just wait for nodejs to close
    // by itself if any remaining handlers are still running.
    // There shouldn't be any.
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
