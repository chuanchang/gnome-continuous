// -*- indent-tabs-mode: nil; tab-width: 2; -*-
// Copyright (C) 2013 Colin Walters <walters@verbum.org>
//
// This library is free software; you can redistribute it and/or
// modify it under the terms of the GNU Lesser General Public
// License as published by the Free Software Foundation; either
// version 2 of the License, or (at your option) any later version.
//
// This library is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
// Lesser General Public License for more details.
//
// You should have received a copy of the GNU Lesser General Public
// License along with this library; if not, write to the
// Free Software Foundation, Inc., 59 Temple Place - Suite 330,
// Boston, MA 02111-1307, USA.

const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Lang = imports.lang;
const Format = imports.format;

const GSystem = imports.gi.GSystem;

const Builtin = imports.builtin;
const ArgParse = imports.argparse;
const ProcUtil = imports.procutil;
const Task = imports.task;
const LibQA = imports.libqa;
const JSUtil = imports.jsutil;

const TIMEOUT_SECONDS = 10 * 60;


const RequiredMessageIDs = ["39f53479d3a045ac8e11786248231fbf", // graphical.target 
                            "f77379a8490b408bbe5f6940505a777b",  // systemd-journald
                            "0ce153587afa4095832d233c17a88001" // gnome-session startup ok
                           ];
const FailedMessageIDs = ["fc2e22bc6ee647b6b90729ab34a250b1", // coredump
                          "10dd2dc188b54a5e98970f56499d1f73" // gnome-session required component failed
                         ];

const SmoketestOne = new Lang.Class({
    Name: 'SmoketestOne',

    _fail: function(message) {
        this._failed = true;
        this._failedMessage = message;
    },
    
    _onQemuExited: function(proc, result) {
        let [success, status] = ProcUtil.asyncWaitCheckFinish(proc, result);
        this._qemu = null;
        this._loop.quit();
        if (!success) {
            this._fail("Qemu exited with status " + status);
        }
    },

    _onTimeout: function() {
        print("Timeout reached");
        for (let msgid in this._pendingRequiredMessageIds) {
            print("Did not see MESSAGE_ID=" + msgid);
        }
        this._fail("Timed out");
        this._loop.quit();
    },

    _onJournalOpen: function(file, result) {
        try {
            this._journalStream = file.read_finish(result);
            this._journalDataStream = Gio.DataInputStream.new(this._journalStream); 
            this._openedJournal = true;
            this._readingJournal = true;
            this._journalDataStream.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable,
                                                    Lang.bind(this, this._onJournalReadLine));
        } catch (e) {
            this._fail("Journal open failed: " + e);
            this._loop.quit();
        }
    },
    
    _onJournalReadLine: function(stream, result) {
        this._readingJournal = false;
        let line, len;
        try {
            [line, len] = stream.read_line_finish_utf8(result);
        } catch (e) {
            this._fail(e.toString());
            this._loop.quit();
            throw e;
        }
        if (this._done || this._failed)
            return;
        if (line) {
            let data = JSON.parse(line);
            let messageId = data['MESSAGE_ID'];
            if (messageId) {
                let matched = false
                if (this._pendingRequiredMessageIds[messageId]) {
                    print("Found required message ID " + messageId);
                    delete this._pendingRequiredMessageIds[messageId];
                    this._countPendingRequiredMessageIds--;
                    matched = true;
                } else {
                    for (let i = 0; i < FailedMessageIDs.length; i++) {
                        if (messageId == FailedMessageIDs[i]) {
                            this._fail("Found failure message ID " + messageId);
                            this._loop.quit();
                            matched = true;
                            break;
                        }
                    }
                }
            }
            if (this._countPendingRequiredMessageIds > 0) {
                this._readingJournal = true;
                this._journalDataStream.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable,
                                                        Lang.bind(this, this._onJournalReadLine));
            } else {
                print("Found all required message IDs, exiting");
                this._done = true;
                this._loop.quit();
            }
        }
    },

    _onJournalChanged: function(monitor, file, otherFile, eventType) {
        if (this._done || this._failed)
            return;
        if (!this._openedJournal) {
            this._openedJournal = true;
            file.read_async(GLib.PRIORITY_DEFAULT,
                            this._cancellable,
                            Lang.bind(this, this._onJournalOpen));
        } else if (!this._readingJournal) {
            this._readingJournal = true;
            this._journalDataStream.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable,
                                                    Lang.bind(this, this._onJournalReadLine));
        }
    },

    execute: function(subworkdir, diskPath, cancellable) {
        print("Smoke testing disk " + diskPath.get_path());
        this._loop = GLib.MainLoop.new(null, true);
        this._done = false;
        this._failed = false;
        this._journalStream = null;
        this._journalDataStream = null;
        this._openedJournal = false;
        this._readingJournal = false;
        this._pendingRequiredMessageIds = {};
        this._countPendingRequiredMessageIds = 0;
        for (let i = 0; i < RequiredMessageIDs.length; i++) {
            this._pendingRequiredMessageIds[RequiredMessageIDs[i]] = true;
            this._countPendingRequiredMessageIds += 1;
        }
        this._cancellable = cancellable;

        let qemuArgs = [LibQA.getQemuPath()];
        qemuArgs.push.apply(qemuArgs, LibQA.DEFAULT_QEMU_OPTS);

        let diskClone = subworkdir.get_child('smoketest-' + diskPath.get_basename());
        GSystem.shutil_rm_rf(diskClone, cancellable);

        LibQA.createDiskSnapshot(diskPath, diskClone, cancellable);
        let [gfmnt, mntdir] = LibQA.newReadWriteMount(diskClone, cancellable);
        try {
            LibQA.modifyBootloaderAppendKernelArgs(mntdir, ["console=ttyS0"], cancellable);

            let [currentDir, currentEtcDir] = LibQA.getDeployDirs(mntdir, 'gnome-ostree');
            
            LibQA.injectExportJournal(currentDir, currentEtcDir, cancellable);
            LibQA.injectTestUserCreation(currentDir, currentEtcDir, 'smoketest', {}, cancellable);
            LibQA.enableAutologin(currentDir, currentEtcDir, 'smoketest', cancellable);
        } finally {
            gfmnt.umount(cancellable);
        }

        let consoleOutput = subworkdir.get_child('console.out');
        let journalOutput = subworkdir.get_child('journal-json.txt');

        qemuArgs.push.apply(qemuArgs, ['-drive', 'file=' + diskClone.get_path() + ',if=virtio',
                                       '-vnc', 'none',
                                       '-serial', 'file:' + consoleOutput.get_path(),
                                       '-device', 'virtio-serial',
                                       '-chardev', 'file,id=journaljson,path=' + journalOutput.get_path(),
                                       '-device', 'virtserialport,chardev=journaljson,name=org.gnome.journaljson']);
        
        let qemuContext = new GSystem.SubprocessContext({ argv: qemuArgs });
        let qemu = new GSystem.Subprocess({context: qemuContext});
        this._qemu = qemu;
        print("starting qemu");
        qemu.init(cancellable);

        qemu.wait(cancellable, Lang.bind(this, this._onQemuExited));

        let journalMonitor = journalOutput.monitor_file(0, cancellable);
        journalMonitor.connect('changed', Lang.bind(this, this._onJournalChanged));

        let timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TIMEOUT_SECONDS,
                                                 Lang.bind(this, this._onTimeout));
        
        this._loop.run();

        if (this._qemu)
            this._qemu.force_exit();

        GLib.source_remove(timeoutId);
        
        if (this._failed) {
            throw new Error(this._failedMessage);
        }
        print("Completed smoke testing of " + diskPath.get_basename());
    }
});

const TaskSmoketest = new Lang.Class({
    Name: 'TaskSmoketest',
    Extends: Task.TaskDef,

    TaskName: "smoketest",
    TaskAfter: ['builddisks'],

    execute: function(cancellable) {
	      let imageDir = this.workdir.get_child('images');
	      let currentImages = imageDir.get_child('current');

        let e = currentImages.enumerate_children('standard::*', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                                                 cancellable);
        let info;
        while ((info = e.next_file(cancellable)) != null) {
            let name = info.get_name();
            if (!JSUtil.stringEndswith(name, '.qcow2'))
                continue;
            let workdirName = 'work-' + name.replace(/\.qcow2$/, '');
            let subworkdir = Gio.File.new_for_path(workdirName);
            GSystem.file_ensure_directory(subworkdir, true, cancellable);
            let smokeTest = new SmoketestOne();
            smokeTest.execute(subworkdir, currentImages.get_child(name), cancellable);
        }
    }
});
