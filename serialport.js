'use strict';

// Copyright 2011 Chris Williams <chris@iterativedesigns.com>

// Require serialport binding from pre-compiled binaries using
// node-pre-gyp, if something fails or package not available fallback
// to regular build from source.

const debug = require('debug')('serialport');
const binary = require('node-pre-gyp');
const path = require('path');
const PACKAGE_JSON = path.join(__dirname, 'package.json');
const binding_path = binary.find(path.resolve(PACKAGE_JSON));
const SerialPortBinding = require(binding_path);

const parsers = require('./parsers');
const EventEmitter = require('events').EventEmitter;
const util = require('util');
const fs = require('fs');
const stream = require('stream');
const async = require('async');
const exec = require('child_process').exec;

function SerialPortFactory(_spfOptions) {
  _spfOptions = _spfOptions || {};

  const spfOptions = {};

  spfOptions.queryPortsByPath =  !!_spfOptions.queryPortsByPath;

  const factory = this;

  // Removing check for valid BaudRates due to ticket: #140
  // const BAUDRATES = [500000, 230400, 115200, 57600, 38400, 19200, 9600, 4800, 2400, 1800, 1200, 600, 300, 200, 150, 134, 110, 75, 50];

  //  VALIDATION ARRAYS
  const DATABITS = [5, 6, 7, 8];
  const STOPBITS = [1, 1.5, 2];
  const PARITY = ['none', 'even', 'mark', 'odd', 'space'];
  const FLOWCONTROLS = ['XON', 'XOFF', 'XANY', 'RTSCTS'];
  const SETS = ['rts', 'cts', 'dtr', 'dts', 'brk'];


  // Stuff from ReadStream, refactored for our usage:
  const kPoolSize = 40 * 1024;
  const kMinPoolSpace = 128;

  function makeDefaultPlatformOptions(){
    const options = {};

    if (process.platform !== 'win32') {
      options.vmin = 1;
      options.vtime = 0;
    }

    return options;
  }

  // The default options, can be overwritten in the 'SerialPort' constructor
  const _options = {
    baudrate: 9600,
    parity: 'none',
    rtscts: false,
    xon: false,
    xoff: false,
    xany: false,
    hupcl:true,
    rts: true,
    cts: false,
    dtr: true,
    dts: false,
    brk: false,
    databits: 8,
    stopbits: 1,
    buffersize: 256,
    parser: parsers.raw,
    platformOptions: makeDefaultPlatformOptions()
  };

  function SerialPort(path, options, openImmediately, callback) {

    const self = this;

    const args = Array.prototype.slice.call(arguments);
    callback = args.pop();
    if (typeof (callback) !== 'function') {
      callback = null;
    }
    options = (typeof options !== 'function') && options || {};

    const opts = {};

    openImmediately = (openImmediately === undefined || openImmediately === null) ? true : openImmediately;

    stream.Stream.call(this);

    callback = callback || function (err) {
      if (err) {
        if (self._events.error) {
          self.emit('error', err);
        } else {
          factory.emit('error', err);
        }
      }
    };

    let err;


    opts.baudRate = options.baudRate || options.baudrate || _options.baudrate;

    opts.dataBits = options.dataBits || options.databits || _options.databits;
    if (DATABITS.indexOf(opts.dataBits) === -1) {
      err = new Error('Invalid "databits": ' + opts.dataBits);
      callback(err);
      return;
    }

    opts.stopBits = options.stopBits || options.stopbits || _options.stopbits;
    if (STOPBITS.indexOf(opts.stopBits) === -1) {
      err = new Error('Invalid "stopbits": ' + opts.stopbits);
      callback(err);
      return;
    }

    opts.parity = options.parity || _options.parity;
    if (PARITY.indexOf(opts.parity) === -1) {
      err = new Error('Invalid "parity": ' + opts.parity);
      callback(err);
      return;
    }
    if (!path) {
      err = new Error('Invalid port specified: ' + path);
      callback(err);
      return;
    }

    // flush defaults, then update with provided details
    opts.rtscts = _options.rtscts;
    opts.xon = _options.xon;
    opts.xoff = _options.xoff;
    opts.xany = _options.xany;

    if (options.flowControl || options.flowcontrol) {
      const fc = options.flowControl || options.flowcontrol;

      if (typeof fc === 'boolean') {
        opts.rtscts = true;
      } else {
        const clean = fc.every(function (flowControl) {
          const fcup = flowControl.toUpperCase();
          const idx = FLOWCONTROLS.indexOf(fcup);
          if (idx < 0) {
            const err = new Error('Invalid "flowControl": ' + fcup + '. Valid options: ' + FLOWCONTROLS.join(', '));
            callback(err);
            return false;
          } else {

            // "XON", "XOFF", "XANY", "DTRDTS", "RTSCTS"
            switch (idx) {
              case 0: opts.xon = true; break;
              case 1: opts.xoff = true; break;
              case 2: opts.xany = true;  break;
              case 3: opts.rtscts = true; break;
            }
            return true;
          }
        });
        if(!clean){
          return;
        }
      }
    }

    opts.bufferSize = options.bufferSize || options.buffersize || _options.buffersize;
    opts.parser = options.parser || _options.parser;
    opts.platformOptions = options.platformOptions || _options.platformOptions;
    options.hupcl = (typeof options.hupcl === 'boolean') ? options.hupcl : _options.hupcl;
    opts.dataCallback = options.dataCallback || function (data) {
      opts.parser(self, data);
    };

    opts.disconnectedCallback = options.disconnectedCallback || function (err) {
      if (self.closing) {
        return;
      }
      if (!err) {
        err = new Error('Disconnected');
      }
      self.emit('disconnect', err);
    };

    if (process.platform !== 'win32') {
      // All other platforms:
      this.fd = null;
      this.paused = true;
      this.bufferSize = options.bufferSize || 64 * 1024;
      this.readable = true;
      this.reading = false;
    }

    this.options = opts;
    this.path = path;
    if (openImmediately) {
      process.nextTick(function () {
        self.open(callback);
      });
    }
  }

  util.inherits(SerialPort, stream.Stream);


  SerialPort.prototype.open = function (callback) {
    const self = this;
    this.paused = true;
    this.readable = true;
    this.reading = false;
    factory.SerialPortBinding.open(this.path, this.options, function (err, fd) {
      self.fd = fd;
      if (err) {
        if (callback) {
          callback(err);
        } else {
          self.emit('error', err);
        }
        return;
      }
      if (process.platform !== 'win32') {
        self.paused = false;
        self.serialPoller = new factory.SerialPortBinding.SerialportPoller(self.fd, function (err) {
          if (!err) {
            self._read();
          } else {
            self.disconnected(err);
          }
        });
        self.serialPoller.start();
      }

      self.emit('open');
      if (callback) { callback(); }
    });
  };

  //underlying code is written to update all options, but for now
  //only baud is respected as I dont want to duplicate all the option
  //verification code above
  SerialPort.prototype.update = function (options, callback) {
    const self = this;
    if (!this.fd) {
      debug('Update attempted, but serialport not available - FD is not set');
      const err = new Error('Serialport not open.');
      if (callback) {
        callback(err);
      } else {
        // console.log("write-fd");
        self.emit('error', err);
      }
      return;
    }

    this.options.baudRate = options.baudRate || options.baudrate || _options.baudrate;

    factory.SerialPortBinding.update(this.fd, this.options, function (err) {
      if (err) {
        if (callback) {
          callback(err);
        } else {
          self.emit('error', err);
        }
        return;
      }
      self.emit('open');
      if (callback) { callback(); }
    });
  };

  SerialPort.prototype.isOpen = function() {
    return !!this.fd;
  };

  SerialPort.prototype.write = function (buffer, callback) {
    const self = this;
    if (!this.fd) {
      debug('Write attempted, but serialport not available - FD is not set');
      const err = new Error('Serialport not open.');
      if (callback) {
        callback(err);
      } else {
        // console.log("write-fd");
        self.emit('error', err);
      }
      return;
    }

    if (!Buffer.isBuffer(buffer)) {
      buffer = new Buffer(buffer);
    }
    debug('Write: '+JSON.stringify(buffer));
    factory.SerialPortBinding.write(this.fd, buffer, function (err, results) {
      if (callback) {
        callback(err, results);
      } else {
        if (err) {
          // console.log("write");
          self.emit('error', err);
        }
      }
    });
  };

  if (process.platform !== 'win32') {
    SerialPort.prototype._read = function () {
      const self = this;

      // console.log(">>READ");
      if (!self.readable || self.paused || self.reading) {
        return;
      }

      self.reading = true;

      if (!self.pool || self.pool.length - self.pool.used < kMinPoolSpace) {
        // discard the old pool. Can't add to the free list because
        // users might have refernces to slices on it.
        self.pool = null;

        // alloc new pool
        self.pool = new Buffer(kPoolSize);
        self.pool.used = 0;
      }

      // Grab another reference to the pool in the case that while we're in the
      // thread pool another read() finishes up the pool, and allocates a new
      // one.
      const toRead = Math.min(self.pool.length - self.pool.used, ~~self.bufferSize);
      const start = self.pool.used;

      function afterRead(err, bytesRead, readPool, bytesRequested) {
        self.reading = false;
        if (err) {
          if (err.code && err.code === 'EAGAIN') {
            if (self.fd >= 0) {
              self.serialPoller.start();
            }
          } else if (err.code && (err.code === 'EBADF' || err.code === 'ENXIO' || (err.errno === -1 || err.code === 'UNKNOWN'))) { // handle edge case were mac/unix doesn't clearly know the error.
            self.disconnected(err);
          } else {
            self.fd = null;
            self.emit('error', err);
            self.readable = false;
          }
        } else {
          // Since we will often not read the number of bytes requested,
          // let's mark the ones we didn't need as available again.
          self.pool.used -= bytesRequested - bytesRead;

          if (bytesRead === 0) {
            if (self.fd >= 0) {
              self.serialPoller.start();
            }
          } else {
            const b = self.pool.slice(start, start + bytesRead);

            // do not emit events if the stream is paused
            if (self.paused) {
              self.buffer = Buffer.concat([self.buffer, b]);
              return;
            } else {
              self._emitData(b);
            }

            // do not emit events anymore after we declared the stream unreadable
            if (!self.readable) {
              return;
            }
            self._read();
          }
        }

      }

      fs.read(self.fd, self.pool, self.pool.used, toRead, null, function (err, bytesRead) {
        const readPool = self.pool;
        afterRead(err, bytesRead, readPool, toRead);
      });

      self.pool.used += toRead;
    };


    SerialPort.prototype._emitData = function (data) {
      this.options.dataCallback(data);
    };

    SerialPort.prototype.pause = function () {
      const self = this;
      self.paused = true;
    };

    SerialPort.prototype.resume = function () {
      const self = this;
      self.paused = false;

      if (self.buffer) {
        const buffer = self.buffer;
        self.buffer = null;
        self._emitData(buffer);
      }

      // No longer open?
      if (null === self.fd) {
        return;
      }

      self._read();
    };

  } // if !'win32'


  SerialPort.prototype.disconnected = function (err) {
    const self = this;

    // send notification of disconnect
    if (self.options.disconnectedCallback) {
      self.options.disconnectedCallback(err);
    } else {
      self.emit('disconnect', err);
    }
    self.paused = true;
    self.closing = true;

    self.emit('close');

    // clean up all other items
    fd = self.fd;

    try {
      factory.SerialPortBinding.close(fd, function (err) {
        if (err) {
          debug('Disconnect completed with error: '+JSON.stringify(err));
        } else {
          debug('Disconnect completed.');
        }
      });
    } catch (e) {
      debug('Disconnect completed with an exception: '+JSON.stringify(e));
    }

    self.removeAllListeners();
    self.closing = false;
    self.fd = 0;

    if (process.platform !== 'win32') {
      self.readable = false;
      self.serialPoller.close();
    }

  };


  SerialPort.prototype.close = function (callback) {
    const self = this;

    const fd = self.fd;

    if (self.closing) {
      return;
    }
    if (!fd) {
      const err = new Error('Serialport not open.');
      if (callback) {
        callback(err);
      } else {
        // console.log("sp not open");
        self.emit('error', err);
      }
      return;
    }

    self.closing = true;

    // Stop polling before closing the port.
    if (process.platform !== 'win32') {
      self.readable = false;
      self.serialPoller.close();
    }

    try {
      factory.SerialPortBinding.close(fd, function (err) {

        if (err) {
          if (callback) {
            callback(err);
          } else {
            // console.log("doclose");
            self.emit('error', err);
          }
          return;
        }

        self.emit('close');
        self.removeAllListeners();
        self.closing = false;
        self.fd = 0;

        if (callback) {
          callback();
        }
      });
    } catch (ex) {
      self.closing = false;
      if (callback) {
        callback(ex);
      } else {
        self.emit('error', ex);
      }
    }
  };

  function listUnix(callback) {
    function checkPort(portName, callback) {
      fs.exists(portName, function(exists) {
        if (exists) {
          return callback(null, portName);
        }
        const i = parseInt(portName.match(/.*?(\d+)$/)[1]);
        exec(`mknod ${portName}- c 188 ${i} && chown root:dialout ${portName}- && chmod 0660 ${portName}- && mv ${portName}- ${portName}`, function (err) {
          if (err) {
            console.error('error while mknod', err);
          }
          else {
            debug('create node', portName);
          }
          callback && callback(err, portName);
        });
      });
    }
    function udev_parser(udev_output, callback) {
      function udev_output_to_json(output) {
        const result = {};
        const lines = output.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line !== '') {
            const line_parts = lines[i].split('=');
            result[line_parts[0].trim()] = line_parts[1].trim();
          }
        }
        return result;
      }
      const as_json = udev_output_to_json(udev_output);

      let pnpId;
      // queryPortsByPath is always false?
      const rePnpId = (spfOptions.queryPortsByPath ? /\/dev\/serial\/by-path\/(\S*)/g : /\/dev\/serial\/by-id\/(\S*)/g);
      let matches;
      if(as_json.DEVLINKS) {
        matches = rePnpId.exec(as_json.DEVLINKS);
        pnpId = matches && matches[1] || as_json.DEVLINKS.split(' ')[0];
        pnpId = pnpId.substring(pnpId.lastIndexOf('/') + 1);
      }
      const port = {
        comName: as_json.DEVNAME,
        manufacturer: as_json.ID_VENDOR,
        serialNumber: as_json.ID_SERIAL,
        pnpId: pnpId,
        vendorId: '0x' + as_json.ID_VENDOR_ID,
        productId: '0x' + as_json.ID_MODEL_ID
      };

      checkPort(port.comName, function() {
        callback(null, port);
      });
    }

    const dirName = '/dev/serial/by-id';

    fs.readdir(dirName, function (err, files) {
      if (err) {
        // if this directory is not found this could just be because it's not plugged in
        if (err.errno === 34 || err.errno === -2) {
          console.error('Directory is not found', dirName);
          return callback(null, []);
        }
        console.error('error while readdir', err.stack);
        if (callback) {
          callback(err);
        } else {
          factory.emit('error', err);
        }
        return;
      }

      async.map(files, function (file, callback) {
        function resolveFileName(callback) {
          let fileName = path.join(dirName, file);
          try {
            fileName = path.resolve(dirName, fs.readlinkSync(fileName));
            checkPort(fileName, callback)
          } catch (e) {
            callback(null, fileName);
          }
        }

        resolveFileName(function(err, fileName) {
          const cmd = `/sbin/udevadm info --query=property -p $(/sbin/udevadm info -q path -n ${fileName})`;
          debug('exec', cmd);
          exec(cmd, function (err, stdout) {
            if (err) {
              console.error('error while udevadm', err);
              if (callback) {
                callback();
              } else {
                factory.emit('error', err);
              }
              return;
            }

            udev_parser(stdout, callback);
          });
        });
      }, function(err, ports) {
        callback(err, ports && ports.filter(port => !!port));
      });
    });
  }

  SerialPort.prototype.flush = function (callback) {
    const self = this;
    const fd = self.fd;

    if (!fd) {
      const err = new Error('Serialport not open.');
      if (callback) {
        callback(err);
      } else {
        self.emit('error', err);
      }
      return;
    }

    factory.SerialPortBinding.flush(fd, function (err, result) {
      if (err) {
        if (callback) {
          callback(err, result);
        } else {
          self.emit('error', err);
        }
      } else {
        if (callback) {
          callback(err, result);
        }
      }
    });
  };

  SerialPort.prototype.set = function (options, callback) {
    const self = this;
    const fd = self.fd;

    options = (typeof option !== 'function') && options || {};

    // flush defaults, then update with provided details

    if(!options.hasOwnProperty('rts')){
      options.rts = _options.rts;
    }
    if(!options.hasOwnProperty('dtr')){
      options.dtr = _options.dtr;
    }
    if(!options.hasOwnProperty('cts')){
      options.cts = _options.cts;
    }
    if(!options.hasOwnProperty('dts')){
      options.dts = _options.dts;
    }
    if(!options.hasOwnProperty('brk')){
      options.brk = _options.brk;
    }

    if (!fd) {
      const err = new Error('Serialport not open.');
      if (callback) {
        callback(err);
      } else {
        self.emit('error', err);
      }
      return;
    }

    factory.SerialPortBinding.set(fd, options, function (err, result) {
      if (err) {
        if (callback) {
          callback(err, result);
        } else {
          self.emit('error', err);
        }
      } else {
        callback(err, result);
      }
    });
  };

  SerialPort.prototype.drain = function (callback) {
    const self = this;
    const fd = this.fd;

    if (!fd) {
      const err = new Error('Serialport not open.');
      if (callback) {
        callback(err);
      } else {
        self.emit('error', err);
      }
      return;
    }

    factory.SerialPortBinding.drain(fd, function (err, result) {
      if (err) {
        if (callback) {
          callback(err, result);
        } else {
          self.emit('error', err);
        }
      } else {
        if (callback) {
          callback(err, result);
        }
      }
    });
  };

  factory.SerialPort = SerialPort;
  factory.parsers = parsers;
  factory.SerialPortBinding = SerialPortBinding;

  if (process.platform === 'win32') {
    factory.list = SerialPortBinding.list;
  } else if (process.platform === 'darwin') {
    factory.list = SerialPortBinding.list;
  } else {
    // waiting for /dev/serial/by-id 3s
    let ready = Promise.resolve();
    factory.list = function (callback) {
      ready = ready.then(function () {
        return new Promise(function(resolve) {
          setTimeout(function() {
            listUnix(function (err, ports) {
              callback(err, ports);
              resolve();
              // setTimeout(resolve, 2000);
            });
          }, 3000);
        });
      });
    };
  }

}

util.inherits(SerialPortFactory, EventEmitter);

module.exports = new SerialPortFactory();
