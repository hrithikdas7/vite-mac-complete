import { app, shell, BrowserWindow, ipcMain, dialog, ipcRenderer, Notification, Tray } from 'electron'
import path, { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { startDetection, stopDetection, getInteractionTimestamps, resetInteractionTimeStampsForActivity } from './InputDetection'
import takeScreenshot from './CronJobs'
import cron from 'node-cron'
import { calculateActivityPercentage, calculateIdleTime } from './ActivityAnalyser'
import { GivePermission } from './Permissions'
import { takeScreenshotLinux } from './CronJobs'
const sqlite3 = require('sqlite3').verbose();
import moment from 'moment'

let db = new sqlite3.Database('./data.db', (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to the SQLite database.');
  }
});

const isPackaged = app.isPackaged
let mainWindow

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient("electron", process.execPath, [
      path.resolve(process.argv[1]),
      console.log(path.resolve(process.argv[1])),
    ]);
  }
} else {
  app.setAsDefaultProtocolClient("electron");
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
  console.log("nolock");
} else {
  app.on("second-instance", (event, commandLine, workingDirectory) => {
    console.log("yess");
    // Someone tried to run a second instance, we should focus our window.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }

    mainWindow.webContents.send("auth", {
      commandLine,
    });
    dialog.showErrorBox(
      "Welcome Back",
      `You arrived from: ${commandLine.pop().slice(0, -1)}`
    );
  });

  // // Create mainWindow, load the rest of the app, etc...
  // app.whenReady().then(() => {
  //   createWindow();
  //   // setInterval(logCursorPosition, 10000);
  // });

  app.on("open-url", (event, url) => {
    console.log("open-url event triggered:", url);

    dialog.showErrorBox("Welcome Back", `You arrived from: ${url}`);
  });
}

function createWindow() {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      backgroundThrottling: false,
      devTools: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    mainWindow.webContents.openDevTools()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')




  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.Add an entitlements.mac.plist 
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  createWindow()
  if (process.platform === "linux") {
    GivePermission()

  }


  // startMouseMovementDetectionwin()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

//Logicss

const handleScreenshot = async () => {
  try {
    const dataURL = await takeScreenshot()
    mainWindow.webContents.send("ssUrl", dataURL);
    // console.log('Screenshot taken:', dataURL);
  } catch (error) {
    console.error('Failed to take screenshot:', error)
  }
}

let Cronjob





ipcMain.on('IdlemodalHasbeemclosed', () => {
  console.log("modal has been closed")
  startDetection('mouse', mainWindow);
  startDetection('keyboard', mainWindow);
})

ipcMain.on('startdetection', () => {
  if (Cronjob) {
    console.log("existing cron job has been stopped")
    Cronjob.stop()
  }

  startDetection('mouse', mainWindow);
  startDetection('keyboard', mainWindow);

  Cronjob = cron.schedule('* * * * *', () => {
    console.log('running a task every minute');
    const activityArr = getInteractionTimestamps();
    const currenttimestamp = Date.now();
    const idleTime = calculateIdleTime(activityArr?.interactionTimestamps, currenttimestamp);
    const currentTime = moment().format('HH:mm');
    // Store data in the SQLite database
    db.serialize(() => {
      db.run('CREATE TABLE IF NOT EXISTS activity_data (timestamp INTEGER, idleTime INTEGER, activityPercent REAL)');
      const stmt = db.prepare('INSERT INTO activity_data (timestamp, idleTime, activityPercent) VALUES (?, ?, ?)');
      stmt.run(currentTime, idleTime, null); // Insert null for activityPercent when idleTime > 0
      stmt.finalize();
    });

    if (idleTime > 0) {
      mainWindow.webContents.send("showIdlemodal", idleTime);
      mainWindow.restore();
      stopDetection('mouse')
      stopDetection('keyboard')
    } else {
      console.log(idleTime, "idletime");
      const activityPercent = calculateActivityPercentage(activityArr?.interactionActivityTimestamps, 60);
      mainWindow.webContents.send("activitypersent", activityPercent);
      console.log(activityPercent, "activity percentage");

      // Update the database with activityPercent when idleTime is 0
      db.serialize(() => {
        const updateStmt = db.prepare('UPDATE activity_data SET activityPercent = ? WHERE timestamp = ?');
        updateStmt.run(activityPercent, currentTime);
        updateStmt.finalize();
      });

      if (process.platform === "linux") {
        takeScreenshotLinux();
      } else {
        handleScreenshot();
      }
    }

    resetInteractionTimeStampsForActivity();
  });
});



ipcMain.on('stopdetection', () => {
  db.run('DELETE FROM activity_data');
  Cronjob.stop()
  stopDetection('mouse')
  stopDetection('keyboard')
})

// In this file you can include the rest of your app"s specific main process
// code. You can also put them in separate files and require them here.
// function takeScreenshotLinux() {
//   console.log("screenshot execution")
//   const screenshotPath = path.join(__dirname, 'screenshotoll.png');

//   exec(`gnome-screenshot -d 2 -f "${screenshotPath}"`, (error, stdout, stderr) => {
//       if (error) {
//           console.error(`Error: ${error.message}`);
//           return;
//       }
//       if (stderr) {
//           console.error(`stderr: ${stderr}`);
//           return;
//       }
//       console.log(`stdout: ${stdout}`);

//       fs.readFile(screenshotPath, (err, data) => {
//           if (err) {
//               console.error(`Error reading file: ${err}`);
//               return;
//           }

//           console.log('Screenshot data loaded, file size:', data.length);

//           const notification = new Notification({
//               title: "Screenshot Taken",
//               body: "Screenshot has been captured successfully",
//           });
//           notification.show();
//       });
//   });


