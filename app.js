var express = require("express"),
	app = express(),
	server = require('http').createServer(app),
	io = require('socket.io').listen(server),
	mongoose = require('mongoose'),
	users = {};

server.listen(process.env.PORT || 3000); //start listening on env port or 3000 


// redis

if (process.env.REDISTOGO_URL) {
    // TODO: redistogo connection
    var rtg   = require("url").parse(process.env.REDISTOGO_URL);
	var redisClient = require("redis").createClient(rtg.port, rtg.hostname);
	redisClient.auth(rtg.auth.split(":")[1]);

} else {
    var redis = require('redis'),
	credentials = { "host": "127.0.0.1", "port": 6379},
	redisClient = redis.createClient(credentials.port, credentials.host);
}



// var redis = require('redis'),
// 	credentials = { "host": "127.0.0.1", "port": 6379},
// 	redisClient = redis.createClient(credentials.port, credentials.host);



// mongoDb
if (process.env.MONGODB_URI){

	// var uri = require('url').parse(process.env.MONGODB_URI);
	mongoose.connect(process.env.MONGODB_URI, function(err){

	if(err){
		console.log("Error connecting to Mongo db. Please check if server is running.");
	}else{
		console.log("Mongo db successfully connected.");
	}
});

}else{

	mongoose.connect('mongodb://localhost/chatroom', function(err){

	if(err){
		console.log("Error connecting to Mongo db. Please check if server is running.");
	}else{
		console.log("Mongo db successfully connected.");
	}
});

}



// var chatSchema = mongoose.Schema({
// 	nick: String,
// 	msg: String,
// 	created: {type: Date, default: Date.now}
// });

var nickSchema = mongoose.Schema({
	nick: String,
	email: String,
	role: {type: String, default: "user"},
	status: {type: String, default: "normal"}
});

// var Chat = mongoose.model('Message', chatSchema);
var Nick = mongoose.model('Users', nickSchema);

// routes

app.get('/', function(req, res){
	res.sendFile(__dirname+"/index.html"); 
});

//socket.io intializing..

io.sockets.on('connection', function(socket){

	// var query = Chat.find({});
	// query.sort('-created').limit(10).exec(function(err, docs){
	// 	if(err) throw err;
		
	// 	socket.emit("chat history", docs);
	// 	console.log("Chat History is retrieved.");

	// });

	// set nickname before enter into chatroom

	socket.on('set nick', function(data, callback){
		socket.nickname = data.nick;
		var duplicateNick = checkDuplicate(socket.nickname);
		if(data.nick == '' || data.email == ''){
			callback({'notEmpty':false, 'noDuplicate':false});
		}else{
			Nick.findOne({'email':data.email}, function(err, result){
			if(err)throw err;
			// existing records found
			if(result){
				if(result.status == 'banned'){
					callback({'banned': true});  // display banned message
				}
				else if(socket.nickname in users){
					callback({'notEmpty':true, 'noDuplicate':false}); // check for duplicate logins (same nick and email)
				}
				else if(duplicateNick == false){	//different nick , same email
					saveNick(socket.nickname, data.email); 
					console.log("new user " + socket.nickname + " existing email: " + data.email + " created.");
					callback({'notEmpty':true, 'noDuplicate':true, nick:socket.nickname});
					joinSuccess(socket);
				}
				else{
					    //same email and same nick
					callback({'notEmpty':true, 'noDuplicate':true, nick:socket.nickname});
					joinSuccess(socket);
				};
			// new user login
			}else{
				if(socket.nickname){
					//check if username already exists in db.
					if (duplicateNick){
						callback({'notEmpty':true, 'noDuplicate':false});
					}else{
						saveNick(socket.nickname, data.email);
						console.log("new user " + socket.nickname + " new email: " + data.email + " created.");	
						callback({'notEmpty':true, 'noDuplicate':true, nick:socket.nickname});
						joinSuccess(socket);
					}
				}else{
					callback({'notEmpty':false, 'noDuplicate':false});
				}

			}
		});
		}
		

	});

	// fetch chat history

	var redisHistory = redisClient.lrange('messages', 0, 9, function(err, reply){
		if(!err){
			var result = [];
			for(var msg in reply) result.push(JSON.parse(reply[msg]));
			socket.emit('chat history', result);

		}

	});

	// function to check for duplicate nick in db

	function checkDuplicate(nick){
		Nick.findOne({'nick': nick}, function(err, result){
			if(result){
				return true;
			}
			return false;
		});
	};

	function saveNick(nick, email){
		var newNick = new Nick({nick: nick, email: email, role:"user", status: "normal"});
		newNick.save(function(err){
			if(err){throw err;}
				else{
					console.log("New username: " + nick + " created.");
				}
		});
	};

	function joinSuccess(socket){
		users[socket.nickname] = socket;
		updateNickname();	
		socket.broadcast.emit('system message', {status: 'joined', nick: socket.nickname} );
	};


	// refresh connected users list on right panel

	function updateNickname(){
		io.sockets.emit('usernames', {primary: socket.nickname, userlist:Object.keys(users)});
	}

	// sending message in the chatroom

	socket.on('send message', function(data, callback){
		var msg = data.trim();

		// private meesage to specific user
		if (msg.substr(0,4) == "/pm "){
			msg = msg.substr(4);
			var ind = msg.indexOf(" "),
				name = msg.substr(0, ind),
				msg = msg.substr(ind + 1);

			if (name in users){
				users[name].emit('private message', {msg: msg, nick: socket.nickname} );
				users[socket.nickname].emit('private message', {msg: msg, nick: socket.nickname} );
			}else{
				callback(name);
			}
		// ban a specific user	
		} else if(msg.substr(0,3) == "/b "){
			name = msg.substr(3);

			if(name in users){
				Nick.findOne({'nick':socket.nickname}, function(err, result){
					if (result.role == 'admin'){
						Nick.findOne({'nick':name}, function(err, doc){
						doc.status = 'banned';
						// doc.visits.$inc();
						doc.save();
						});
						users[name].emit('ban user', true);
						delete users[name];
						updateNickname();
						io.sockets.emit('system message', {status: 'removed', nick: name} );

					}else{
						users[socket.nickname].emit('system message', {status: 'banError', msg: msg, nick: name});
					}

				});

			}else{
				console.log(msg + ' not found');
				callback(name);
			}

			
		}

		// public message to chatroom
		else {
			// var newMsg = new Chat({nick: socket.nickname, msg: msg});

			// save message in redis db
				io.sockets.emit('new message', {msg: msg, nick: socket.nickname } );
				redisClient.lpush('messages', JSON.stringify({msg: msg, nick:socket.nickname}));
				redisClient.ltrim('messages', 0, 99);
					
			}
			
	});

	// remove user on disconnect

	socket.on('disconnect', function(){
		if(!socket.nickname) {return};
		delete users[socket.nickname];
		updateNickname();
		socket.broadcast.emit('system message', {status: 'disconnected', nick: socket.nickname} );
	});

});
