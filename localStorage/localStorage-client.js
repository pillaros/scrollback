/* global localStorage */
/* global $, libsb, location, window */
var ArrayCache = require('./ArrayCache.js');
var generate = require('../lib/generate');
var cache = {}, core;
var LRU = {};
var messageListener = false;
var domain = location.host;
var path = location.pathname;

(function clearLS(){
	console.log("Local storage version check! ");
	if(!localStorage.hasOwnProperty('version1')){
		console.log("Old version of LocalStorage present, clearing ...");
		localStorage.clear();
		localStorage.version1 = true;
	}else{
		console.log("LocalStorage version is current ...");
	}
})();

function loadArrayCache(key){
	// loads an ArrayCache from LocalStorage.
	var texts;
	if(localStorage.hasOwnProperty(key)){
		try{
			texts = JSON.parse(localStorage[key]);
		}catch(e){
			texts = [];
		}
		return (new ArrayCache(texts));
	} else {
		return (new ArrayCache([]));
	}
}

function saveCache(key){
	// saves an ArrayCache to LocalStorage
	try{
		localStorage[key] = JSON.stringify(cache[key].getItems());
	} catch(e){
		if(e.name == 'QuotaExceededError' || e.code == 22){ // localStorage is full!
			deleteLRU();
			saveCache(key);
		}
	}
	LRU[key] = new Date().getTime();
	save();
}

function generateLSKey(){
	var args = Array.prototype.slice.call(arguments, 0); 
    if(!args) return;  
	var argumentsLC = args.map(function(val){
		return val.toLowerCase();
	});
	return argumentsLC.join('_');
}

function deleteLRU(){
    // deletes the least recently used entry from LocalStorage
    var leastTime = Infinity, leastEntry;
    for(var i in LRU) {
        if(LRU[i] < leastTime){
            leastTime = LRU[i];
            leastEntry = i;
        }
    }
    if(leastTime != Infinity){
        delete LRU[leastEntry];
        delete localStorage[leastEntry];
    }
}

function save(){
	//saves user, session, LRU, rooms, occupantOf, memberOf to LocalStorage
	localStorage.user = JSON.stringify(cache.user);
	localStorage.session = cache.session;
	localStorage.LRU = JSON.stringify(LRU);
	localStorage.rooms = JSON.stringify(cache.rooms);
	localStorage.occupantOf = JSON.stringify(cache.occupantOf);
	localStorage.memberOf = JSON.stringify(cache.memberOf);
}

(function load(){
	// loads entries saved by save()
	try{
		cache.user = JSON.parse(localStorage.user);
		cache.session = localStorage.session;
		LRU = JSON.parse(localStorage.LRU);
		cache.rooms = JSON.parse(localStorage.rooms);
		cache.occupantOf = JSON.parse(localStorage.occupantOf);
		cache.memberOf = JSON.parse(localStorage.memberOf);	
	}catch(e){
		// do nothing, e is thrown when values do not exist in localStorage, 
		// which is a valid scenario, execution must continue.
	}
})();

libsb.on('navigate', function(state, next) {
	if(state.roomName && state.roomName != state.old.roomName) {
		var key = generateLSKey(state.roomName, 'texts');
		cache[key] = loadArrayCache(key);
	}
	next();
}, 500);

module.exports = function(c){
	core = c;
	core.on('getTexts', function(query, next){
		// getTextsBefore
		var key = generateLSKey(query.to, 'texts');
		if(!cache.hasOwnProperty(key)){
			cache[key] = loadArrayCache(key);
		}
		
		var results = cache[key].get(query);
			
		if(results && results.length === 1) return next();
		
		if(!results || !results.length){
			next();
		}else{
			query.results = results;
		}
		next();
	}, 200); // runs before the socket
	
	core.on('getTexts', function(query, next){
		var results = query.results;
		if(results && results.length > 0){
			// merging results into the Cache.
			if(query.before){
				results.push({type: 'result-end', endtype: 'time', time:query.time});
			}
			if(query.after){
				results.unshift({type: 'result-start', endtype: 'time', time: query.time});
			}
			if(query.before && results.length === query.before){
				results.unshift({type: 'result-start', time: results[0].time, endtype: 'limit'});
			}
			if(query.after && results.length === query.after){
				results.push({type: 'result-end', time: results[results.length - 1].time, endtype: 'limit'});
			}
			var lskey = generateLSKey(query.to, 'texts');
			if(!cache.hasOwnProperty(lskey)) loadArrayCache(lskey);
			cache[lskey].put(results);
			saveCache(lskey);
		}
		next();
	}, 8); // runs after the socket
	
	core.on('text-dn', function(text, next){
		var texts = [text];
		var key = generateLSKey(text.to, 'texts');
		if(cache && cache[key]) cache[key].put(texts);
		saveCache(key);
		next();
	}, 500); // storing new texts to cache.
	
	core.on('connected', function(){
		var sid;
		if(!cache) cache = {};
		if(cache && cache.session) sid = cache.session;
		if(!sid){
			cache.session = sid = generate.uid();
			libsb.session = cache.session;
		} 
		core.emit('init-up', {session: sid});
	}, 500);
	
	core.on('init-dn', function(init, next){
		cache.user = init.user;
		cache.rooms = init.rooms;
		cache.occupantOf = init.occupantOf;
		cache.memberOf = init.memberOf;
		save();
		next();
	}, 500);
	
	core.on('away-up', function(away, next){
		// store a result-end to the end of ArrayCache to show that the text stream is over for the current user
		var msg = {type: 'result-end', endtype: 'time', time: away.time};
		var key = generateLSKey(away.to, 'texts');
		if(cache && cache[key]) cache[key].put(msg);
		next();
	}, 500);
	
	core.on('back-up', function(back, next){
		// store a result-start in ArrayCache, to indicate the beginning of the current stream of messages from the user
		var msg = {type: 'result-start', endtype: 'time', time: back.time};
		var key = generateLSKey(back.to, 'texts');
		if(cache && cache[key]) cache[key].put(msg);
		next();
	}, 500);
	
	core.on('connected', function() {
		if (window.parent.location === window.location) {
			createInit();	
		} else {
			if(!messageListener) {
				$(window).on("message", function(e) {
					var data = e.originalEvent.data;
					try { data = JSON.parse(data);} catch(e) {return;}
					if (typeof data === "object" && data.location) {
						domain = data.location.host;
						path = data.location.pathname;
					}
					createInit();
				});
				window.parent.postMessage("getDomain", "*");
				messageListener = true;
			} else createInit();
		}
		
	}, 1000);
	core.on('init-dn', recvInit, 900);
	core.on('logout', logout, 1000);
};

function recvInit(init, next){
	cache.user = init.user;
	cache.rooms = init.rooms;
	cache.occupantOf = init.occupantOf;
	cache.memberOf = init.memberOf;
	save();
	next();
}

function createInit(){
	var sid;
	if(!cache) cache = {};
	if(cache && cache.session) {
        libsb.session = sid = cache.session;
    }
	if(!sid){
        
		cache.session = sid = "web:"+generate.uid();
		libsb.session = cache.session;
	}
	core.emit('init-up', {session: sid, origin: {
		gateway: "web",
		domain: domain,
		path: path
	}});
}

function logout(p,n){
	// delete user session here
	delete cache.session;
	delete cache.user;
	delete libsb.session;
	delete libsb.user;
	save();
	n();
}