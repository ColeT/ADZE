chrome.action.onClicked.addListener((tab) => {
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['content.js']
  });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  function sendResult(result) {
    sendResponse(result);
  }
  if (typeof request.adze === 'undefined') {
    return true;
  }
  // Links
  else if (request.adze.updateFeed) {
    updateFeed(request.adze.updateFeed).then(sendResult);
  } 
  else if (request.adze.getManifest) {
    getStoredManifest().then(sendResult);
  } else if (request.adze.addDocument) {
    addDocToList(request.adze.addDocument).then(sendResult);
  } else if (request.adze.removeDocument) {
    removeDocFromList(request.adze.removeDocument).then(sendResult);
  // Peers
  }  else if (request.adze.addPeer) {
    addPeerToList(request.adze.addPeer).then(sendResult);
  }  else if (request.adze.removePeer) {
    removePeerFromList(request.adze.removePeer).then(sendResult);
  // Uploading
  } else if (request.adze.getHubCredentials) {
    getStoredCredentials(request.adze.getStoredCredentials).then(sendResult);
  } else if (request.adze.setHubCredentials) {
    setHubCredentials(request.adze.setHubCredentials).then(sendResult);
  } else if (request.adze.uploadToHub) {
    uploadToHub(request.adze.uploadToHub).then(sendResult);
  }
  // This tells the runtime, 'yes we will return a response'.
  // if you dont' do this here, the runtime will drop the connection
  // and you won't be able to send the response.
  return true;
});

////////////////////////////////////////////////////////////////////////////////
// Feed
////////////////////////////////////////////////////////////////////////////////
const MANIFEST_CACHE_PEER =  'adzePeerManifestCache';
function makeNewCache() { 
  return{
    // mapping from peer to manifest file
    peers: []
  };
}
async function updatePeerManifestCache(numTimesToFollow) {
  var localManifest = await getStoredManifest();
  // todo: have this load from stored value to update rether than make a new one
  var currentCache = makeNewCache();
  // update the list of all cached content from the peers
  var peersSeenSoFar = {};
  var toVisit = [];
  var toVisitNext = [];
  var thisPeerOrder = 1;
  // make a plan to visit all the local peers
  for (var peerNo in localManifest.content.peers) {
    var peer = localManifest.content.peers[peerNo];
    peersSeenSoFar[peer.url] = true;
    toVisit.push(peer);
  }

  while (numTimesToFollow > 0) {
      for (var peerNo in toVisit) {
        var peer = toVisit[peerNo];
        var thisPeerManifest = await getPeerManifest(peer.url);
        peersSeenSoFar[peer.url] = true;
        thisPeerManifest.meta.order = thisPeerOrder;
        thisPeerManifest.meta.url = peer.url;
        currentCache.peers.push(thisPeerManifest);
        // now add this peer's remote peers to visit next
        for (var remotePeerNum in thisPeerManifest.content.peers) {
           var thisRemotePeer = thisPeerManifest.content.peers[remotePeerNum];
          // don't visit this peer twice
          if (typeof peersSeenSoFar[thisRemotePeer.url] === 'undefined') {
              // we will visit this peer if we traverse more hops
              peersSeenSoFar[thisRemotePeer.url] = true;
              toVisitNext.push(thisRemotePeer);
          }
      } // we've considered whether to visit all order n+1 peers of this order n peer
    }
    // we've followed the links once. Decrement counters, reset lets, etc.
    ++thisPeerOrder;
    --numTimesToFollow;
    toVisit = toVisitNext;
    toVisitNext = [];
  }
  // todo: save this cache
  return currentCache;
}

function flattenPeerLinksList(peerManifestCache) {
  // combines links from multuple peers into a single feed
  // for now all we are doing is  putting them in whatever order they are
  // not doing any deduplicatoin
  // todo: eventually give way more options for sorting/scoring
  var linksList = []
  for (var key in peerManifestCache.peers) {
    var thisPeerManifest = peerManifestCache.peers[key]
    thisPeerManifest.content.sites.map((doc) => {
      doc.provenance = { sharers: [ thisPeerManifest.meta ] };
      linksList.push(doc);
    });
  }
  return linksList;
}

// todo: resolve mismatches between titles here
// todo: add assertion that urls match
function mergeFeedDocs(firstDoc, toMerge) {
  firstDoc.timestamp = Math.max(firstDoc.timestamp_ms, toMerge.timestamp_ms);
  firstDoc.provenance.sharers =  [].concat(firstDoc.provenance.sharers, toMerge.provenance.sharers);
  
  return firstDoc;
}

// Takes a flattend links list and combines mutiple referalls for the same site into one
function mergePeerLinksList (linksList) {
  let siteIndex = {};

  linksList.map((doc) => {
    if (typeof siteIndex[doc.url] === 'undefined') {
        // it's new, add it to the resutls list
        siteIndex[doc.url] = doc;
    } else {
      // someone else already shared this. Marge the result
        siteIndex[doc.url] = mergeFeedDocs(siteIndex[doc.url],doc);
    }
  });
  // lastly return the keys
  let resultList = [];
  for (var siteKey in siteIndex) {
    resultList.push(siteIndex[siteKey]);
  }
  return resultList;
}

// sorts a list of peer links according to how many peers adzed it
// TODO: WAY more options here
function sortPeerLinksList(linksList) {
  linksList.sort(function (docA, docB) {
    return docB.provenance.sharers.length - docA.provenance.sharers.length;
  });
}

async function updateFeed() {
  var manifest = await getStoredManifest();
  // update the list of all cached content from the peers
  // how many times should we follow peers?
  // 1 hop: only local peers added by this maniest
  // 2 hops: add 'peers of peers', i.e. order 2 peers
  // todo: make this configurable, dynamic
  var numPeerHops = 2;
  var peerCache = await updatePeerManifestCache(numPeerHops);
  var mergedLinks =  mergePeerLinksList(flattenPeerLinksList(peerCache));
  sortPeerLinksList(mergedLinks);
  return mergedLinks;
}


// Doc (link) management
async function addDocToList(doc) {
  var manifest = await getStoredManifest();
  manifest.content.sites.push(doc);
  manifestStorage.set(manifest);

  return manifest;
}

function makeManifestWithoutDoc(oldManifest, toRemove) {
  var newManifest = makeNewManifest();
  newManifest.meta = oldManifest.meta;
  newManifest.content.peers = oldManifest.content.peers;
  
  for(let index in oldManifest.content.sites){
    var thisDoc = oldManifest.content.sites[index];
    if (thisDoc.url != toRemove.url) {
      newManifest.content.sites.push(thisDoc);
    }
  }
  return newManifest;
}


async function removeDocFromList(doc, cb) {
  var manifest = await getStoredManifest();
  var newManifest = makeManifestWithoutDoc(manifest, doc);
  manifestStorage.set(newManifest);
  return newManifest;
}


/// Peers
async function getPeerManifest(url) {
  var cleanUrl = cleanPeerUrl(url);
  const response = await fetch(cleanUrl, {
    method: 'GET'
  });
  var responseBody = await response.text();
  return JSON.parse(responseBody);
}


function hasPeerAlready(manifest, peer) {
  for(var peerNum in manifest.content.peers) {  
    var thisPeer = manifest.content.peers[peerNum];
    if (thisPeer.url == peer.url) {
      return true;
    }
  }
  return false;
}

// amazon does dumb stuff with 302's if you are using a non-/-terminated url
// hence this delectable hack
function cleanPeerUrl(baseUrl) {
  if (baseUrl.search("//peers.adze.network/") != -1 && !baseUrl.endsWith('/')) {
    return baseUrl+"/";
  }
  return baseUrl;
}

async function addPeerToList(peer) {
  var manifest = await getStoredManifest();

  if (hasPeerAlready(manifest, peer)) {
      console.log("Peer "+peer.url+" already exists!");
      // TODO: signal that the user has alrady added this peer
      // maybe with some animation that higlights the entry in the list
      return manifest;
  }

  var peerManifest = await getPeerManifest(peer.url);
  peer.nickname = peerManifest.meta.nickname || peerManifest.meta.username;

  manifest.content.peers.push(peer);
  manifestStorage.set(manifest);
  return manifest;
}

async function removePeerFromList(peer) {
  var manifest = await getStoredManifest();
  var newManifest = makeManifestWithoutPeer(manifest, peer);
  manifestStorage.set(newManifest);
  return newManifest;
}

function makeManifestWithoutPeer(oldManifest, toRemove) {
  var newManifest = makeNewManifest();
  // don't start with that default manifest in there.
  newManifest.content.peers = [];
  newManifest.meta = oldManifest.meta;
  newManifest.content.sites = oldManifest.content.sites;
  
  for(let index in oldManifest.content.peers){
    var thisPeer = oldManifest.content.peers[index];
    if (thisPeer.url != toRemove.url) {
      newManifest.content.peers.push(thisPeer);
    }
  }
  return newManifest;
}


const manifestStorage = {
  get: (cb) => {
    chrome.storage.local.get(['manifest'], (result) => {
      storedValue = result.manifest;
      if (typeof storedValue === 'undefined') {
        // if there is no manifest there, make a new one with the 
       // adze creator's list as a recommended start point
        cb(makeNewManifest(true));
      } else {
        return cb(JSON.parse(storedValue));
      }
    });
  },
  set: (value, cb) => {
    chrome.storage.local.set({manifest: JSON.stringify(value)}, cb);
  }
};


function makeNewManifest(addCreator) {
   var result = {
     "meta": { "nickname": "uknown"},
     "content" : {
        "sites": [],
        "peers": [
          
         ]
      }
   };

  if (addCreator) {
      result.content.peers.push( 
        {"url":"https://peers.adze.network/apxhard/",
        "nickname" : "axphard (adze creator)" });
  }
  return result;
}

function isValidManfest() {
  // TODO: add checks here, log if the data is corrupted rather than absent
 return !(typeof manifest === 'undefined' || manifest === null || typeof manifest.meta === 'undefined');
}

// Peer Manifest Cache
function getLocalStorageValue(key) {
  // Immediately return a promise and start asynchronous work
  return new Promise((resolve, reject) => {
    // Asynchronously fetch all data from storage
    chrome.storage.local.get([key], (result) => {
      // Pass any observed errors down the promise chain.
      if (chrome.runtime.lastError) {
        return reject(chrome.runtime.lastError);
      }
      // Pass the data retrieved from storage down the promise chain.
      resolve(result.key);
    });
  });
}

function setLocalStorageValue(key, value) {
  // Immediately return a promise and start asynchronous work
  return new Promise((resolve, reject) => {
    storageCommand = {};
    storageCommand[key] = value;
    chrome.storage.local.set(storageCommand, (result) => {
      // Pass any observed errors down the promise chain.
      if (chrome.runtime.lastError) {
        return reject(chrome.runtime.lastError);
      }
      // Pass the data retrieved from storage down the promise chain.
      resolve();
    });
  });
}
// Manifest
function getStoredManifest() {
  // Immediately return a promise and start asynchronous work
  return new Promise((resolve, reject) => {
    // Asynchronously fetch all data from storage.sync.
    manifestStorage.get( (result) => {
      // Pass any observed errors down the promise chain.
      if (chrome.runtime.lastError) {
        return reject(chrome.runtime.lastError);
      }
      // Pass the data retrieved from storage down the promise chain.
      if (typeof result.meta.nickame === 'undefined' && typeof result.meta.username !== 'undefined') {
        // hacky migration for when this field name changed.
        // ideally there's a file defining types and doing migrations.
        result.meta.nickname = result.meta.username;
        delete result.meta.username;
      }
      resolve(result);
    });
  });
}
function saveManifest(manifest) {
  // Immediately return a promise and start asynchronous work
  return new Promise((resolve, reject) => {
    // Asynchronously fetch all data from storage.sync.
    manifestStorage.set(manifest, (result) => {
      // Pass any observed errors down the promise chain.
      if (chrome.runtime.lastError) {
        return reject(chrome.runtime.lastError);
      }
      // Pass the data retrieved from storage down the promise chain.
      resolve();
    });
  });
}

////////////////////////////////////////////////////////////////////////////////
// Credentials
////////////////////////////////////////////////////////////////////////////////
function getStoredCredentials() {
  // Immediately return a promise and start asynchronous work
  return new Promise((resolve, reject) => {
    // Asynchronously fetch all data from storage.sync.
    chrome.storage.local.get(['credentials'], (result) => {
      // Pass any observed errors down the promise chain.
      if (chrome.runtime.lastError) {
        return reject(chrome.runtime.lastError);
      }
      // Pass the data retrieved from storage down the promise chain.
      resolve(result.credentials);
    });
  });
}

// validate the credentials against thehub
async function setHubCredentials(credentials) {
  var hubRegisterUrl = credentials.hubAddress + "register";

  const response = await fetch(hubRegisterUrl, {
    body: new URLSearchParams({
      username: credentials.username,
      email: credentials.email,
    }),
    method: 'POST',
  });
  var response_json = await response.json();

  if (response_json.result == 'success') {
    credentials.manifestUrl = response_json.manifestUrl;
    credentials.authToken = response_json.authToken;
    // now save these
    await saveCredentials(credentials);
  } else {
    credentials.errorMessage = response_json.message;
  }
  return credentials;
}


function saveCredentials(credentials) {
  //
  // Immediately return a promise and start asynchronous work
  return new Promise((resolve, reject) => {
    // Asynchronously fetch all data from storage.sync.
    chrome.storage.local.set({credentials:credentials}, (result) => {
      // Pass any observed errors down the promise chain.
      if (chrome.runtime.lastError) {
        return reject(chrome.runtime.lastError);
      }
      // Pass the data retrieved from storage down the promise chain.
      resolve();
    });
  });
}

////////////////////////////////////////////////////////////////////////////////
// Uploading the manifest
////////////////////////////////////////////////////////////////////////////////
async function uploadToHub() {
  // we might end up 
  const manifest = await getStoredManifest();
  const credentials = await getStoredCredentials();
  // prepare the parameters to the API call
  console.log(credentials);
  var hubUploadUrl = credentials.hubAddress + "upload-manifest";

  const response = await fetch(hubUploadUrl, {
    body: new URLSearchParams({
      username: credentials.username,
      auth_token: credentials.authToken,
      manifest_body: JSON.stringify(manifest),
    }),
    method: 'POST',
  });
  var response_json = await response.json();
  if (response_json.result == 'success') {
    response_json.manifestUrl =  credentials.manifestUrl;
  }
  return response_json;
}

