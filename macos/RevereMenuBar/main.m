#import <Cocoa/Cocoa.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <UserNotifications/UserNotifications.h>
#import <dlfcn.h>
#import <signal.h>
#import <unistd.h>

static const NSTimeInterval RevereScreenshotInterval = 2.0;
static const CGFloat RevereStatusIconSize = 22.0;
static const CGFloat RevereStatusItemLength = 30.0;
static const NSInteger RevereSampleWidth = 128;
static const NSInteger RevereSampleHeight = 72;
static const NSInteger ReverePixelDiffThreshold = 24;
static const double RevereDiffRatioThreshold = 0.01;
static const double RevereBboxRatioThreshold = 0.02;
static const double RevereEdgeStripRatio = 0.02;
static const NSTimeInterval RevereVisualNotificationCooldown = 60.0;
static NSString * const RevereMirrorCameraDefaultKey = @"mirrorCamera";
static NSString * const RevereNotifyOnChangesDefaultKey = @"notifyOnChanges";

@interface RevereImageSample : NSObject
@property(nonatomic) NSInteger width;
@property(nonatomic) NSInteger height;
@property(nonatomic, strong) NSData *pixels;
@end

@implementation RevereImageSample
@end

@interface RevereDeviceInfo : NSObject
@property(nonatomic, copy) NSString *screenIndex;
@property(nonatomic, copy) NSString *screenName;
@property(nonatomic, copy) NSString *cameraIndex;
@property(nonatomic, copy) NSString *cameraName;
@end

@implementation RevereDeviceInfo
@end

@interface RevereAppDelegate : NSObject <NSApplicationDelegate, NSMenuDelegate>
@property(nonatomic, strong) NSStatusItem *statusItem;
@property(nonatomic, strong) NSMenu *menu;
@property(nonatomic, strong) NSMenuItem *dashboardMenuItem;
@property(nonatomic, strong) NSMenuItem *permissionStatusItem;
@property(nonatomic, strong) NSMenuItem *requestCameraPermissionItem;
@property(nonatomic, strong) NSMenuItem *requestNotificationPermissionItem;
@property(nonatomic, strong) NSMenuItem *watchStatusItem;
@property(nonatomic, strong) NSMenuItem *diffStatusItem;
@property(nonatomic, strong) NSMenuItem *captureTestItem;
@property(nonatomic, strong) NSMenuItem *diffEngineTestItem;
@property(nonatomic, strong) NSMenuItem *watchToggleItem;
@property(nonatomic, strong) NSMenuItem *notifyOnChangesItem;
@property(nonatomic, strong) NSMenuItem *recordStatusItem;
@property(nonatomic, strong) NSMenuItem *deviceStatusItem;
@property(nonatomic, strong) NSMenuItem *screenRecordItem;
@property(nonatomic, strong) NSMenuItem *faceRecordItem;
@property(nonatomic, strong) NSMenuItem *screenTestRecordItem;
@property(nonatomic, strong) NSMenuItem *faceTestRecordItem;
@property(nonatomic, strong) NSMenuItem *cameraTestRecordItem;
@property(nonatomic, strong) NSMenuItem *recordPlanTestItem;
@property(nonatomic, strong) NSMenuItem *stopRecordItem;
@property(nonatomic, strong) NSMenuItem *mirrorItem;
@property(nonatomic, strong) NSMenuItem *loginItem;
@property(nonatomic, strong) NSMenuItem *selfTestItem;
@property(nonatomic, strong) NSPanel *controlPanel;
@property(nonatomic, strong) NSTextField *panelPermissionLabel;
@property(nonatomic, strong) NSTextField *panelWatchLabel;
@property(nonatomic, strong) NSTextField *panelDiffLabel;
@property(nonatomic, strong) NSTextField *panelRecordLabel;
@property(nonatomic, strong) NSTextField *panelDeviceLabel;
@property(nonatomic, strong) NSButton *panelWatchButton;
@property(nonatomic, strong) NSButton *panelScreenButton;
@property(nonatomic, strong) NSButton *panelFaceButton;
@property(nonatomic, strong) NSButton *panelStopButton;
@property(nonatomic, strong) NSButton *panelMirrorButton;
@property(nonatomic, strong) NSButton *panelScreenPermissionButton;
@property(nonatomic, strong) NSButton *panelCameraPermissionButton;
@property(nonatomic, strong) NSButton *panelRetestPermissionButton;
@property(nonatomic) BOOL watchRunning;
@property(nonatomic) BOOL watchNeedsPermission;
@property(nonatomic) BOOL watchInFlight;
@property(nonatomic) NSInteger captureCount;
@property(nonatomic) NSInteger changeCount;
@property(nonatomic) NSTimeInterval lastVisualNotificationAt;
@property(nonatomic, strong) NSTimer *watchTimer;
@property(nonatomic, strong) RevereImageSample *previousSample;
@property(nonatomic) BOOL mirrorCamera;
@property(nonatomic) BOOL notifyOnChanges;
@property(nonatomic, strong) NSTask *recordingTask;
@property(nonatomic, strong) NSPipe *recordingInput;
@property(nonatomic, copy) NSString *recordingPath;
@property(nonatomic) BOOL recordingIncludesFace;
@property(nonatomic) pid_t recordingPID;
@end

static NSString *RevereTimestamp(void) {
    NSDateFormatter *formatter = [[NSDateFormatter alloc] init];
    formatter.dateFormat = @"yyyy-MM-dd-HHmmss";
    return [formatter stringFromDate:[NSDate date]];
}

static NSString *RevereRecordingsDirectory(void) {
    NSString *movies = [NSSearchPathForDirectoriesInDomains(NSMoviesDirectory, NSUserDomainMask, YES) firstObject];
    return [movies stringByAppendingPathComponent:@"Revere"];
}

static NSString *RevereDiagnosticsPath(void) {
    NSString *logs = [NSSearchPathForDirectoriesInDomains(NSLibraryDirectory, NSUserDomainMask, YES) firstObject];
    return [[logs stringByAppendingPathComponent:@"Logs/Revere"] stringByAppendingPathComponent:@"diagnostics.txt"];
}

static NSString *RevereLaunchAgentPath(void) {
    NSString *library = [NSSearchPathForDirectoriesInDomains(NSLibraryDirectory, NSUserDomainMask, YES) firstObject];
    return [library stringByAppendingPathComponent:@"LaunchAgents/dev.revere.menubar.plist"];
}

static NSString *RevereRunTask(NSString *launchPath, NSArray<NSString *> *arguments, BOOL allowFailure, int *status) {
    NSTask *task = [[NSTask alloc] init];
    task.launchPath = launchPath;
    task.arguments = arguments;
    NSPipe *stdoutPipe = [NSPipe pipe];
    NSPipe *stderrPipe = [NSPipe pipe];
    task.standardOutput = stdoutPipe;
    task.standardError = stderrPipe;

    @try {
        [task launch];
        [task waitUntilExit];
    } @catch (NSException *exception) {
        if (status) { *status = -1; }
        return exception.reason ?: @"Task failed.";
    }

    NSData *stdoutData = [[stdoutPipe fileHandleForReading] readDataToEndOfFile];
    NSData *stderrData = [[stderrPipe fileHandleForReading] readDataToEndOfFile];
    NSString *stdoutText = [[NSString alloc] initWithData:stdoutData encoding:NSUTF8StringEncoding] ?: @"";
    NSString *stderrText = [[NSString alloc] initWithData:stderrData encoding:NSUTF8StringEncoding] ?: @"";
    int taskStatus = task.terminationStatus;
    if (status) { *status = taskStatus; }
    NSString *combined = [@[stdoutText, stderrText] componentsJoinedByString:@"\n"];
    if (taskStatus != 0 && !allowFailure) {
        return combined.length ? combined : [NSString stringWithFormat:@"%@ exited with %d", launchPath, taskStatus];
    }
    return combined;
}

@implementation RevereAppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    (void)notification;
    self.mirrorCamera = [self loadMirrorCameraPreference];
    self.notifyOnChanges = [self loadNotifyOnChangesPreference];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    self.statusItem = [[NSStatusBar systemStatusBar] statusItemWithLength:RevereStatusItemLength];
    self.statusItem.button.image = [self statusImage];
    self.statusItem.button.imagePosition = NSImageOnly;
    self.statusItem.button.toolTip = @"Revere";
    [self buildMenu];
    self.statusItem.menu = self.menu;
    [self refreshDevices:nil];
    [self updateMenuState];
}

- (NSImage *)statusImage {
    NSString *path = [[NSBundle mainBundle] pathForResource:@"RevereStatusIcon" ofType:@"png"];
    NSImage *image = path ? [[NSImage alloc] initWithContentsOfFile:path] : nil;
    if (!image) {
        image = [[NSImage alloc] initWithSize:NSMakeSize(RevereStatusIconSize, RevereStatusIconSize)];
        [image lockFocus];
        [[NSColor blackColor] setFill];
        NSBezierPath *path = [NSBezierPath bezierPath];
        [path moveToPoint:NSMakePoint(4, 16)];
        [path lineToPoint:NSMakePoint(18, 11)];
        [path lineToPoint:NSMakePoint(9, 6)];
        [path closePath];
        [path fill];
        [image unlockFocus];
    }
    image.size = NSMakeSize(RevereStatusIconSize, RevereStatusIconSize);
    image.template = YES;
    return image;
}

- (BOOL)loadMirrorCameraPreference {
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    if ([defaults objectForKey:RevereMirrorCameraDefaultKey] == nil) {
        [defaults setBool:YES forKey:RevereMirrorCameraDefaultKey];
        return YES;
    }
    return [defaults boolForKey:RevereMirrorCameraDefaultKey];
}

- (void)saveMirrorCameraPreference {
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    [defaults setBool:self.mirrorCamera forKey:RevereMirrorCameraDefaultKey];
    [defaults synchronize];
}

- (BOOL)loadNotifyOnChangesPreference {
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    if ([defaults objectForKey:RevereNotifyOnChangesDefaultKey] == nil) {
        [defaults setBool:YES forKey:RevereNotifyOnChangesDefaultKey];
        return YES;
    }
    return [defaults boolForKey:RevereNotifyOnChangesDefaultKey];
}

- (void)saveNotifyOnChangesPreference {
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    [defaults setBool:self.notifyOnChanges forKey:RevereNotifyOnChangesDefaultKey];
    [defaults synchronize];
}

- (void)buildMenu {
    self.menu = [[NSMenu alloc] initWithTitle:@"Revere"];
    self.menu.delegate = self;
    self.menu.autoenablesItems = NO;
    self.dashboardMenuItem = [[NSMenuItem alloc] initWithTitle:@"" action:nil keyEquivalent:@""];
    self.dashboardMenuItem.view = [self dashboardMenuView];
    [self.menu addItem:self.dashboardMenuItem];
    [self.menu addItem:[NSMenuItem separatorItem]];

    NSMenuItem *openControls = [self.menu addItemWithTitle:@"Open Controls..." action:@selector(showControls:) keyEquivalent:@""];
    openControls.target = self;
    self.permissionStatusItem = [self.menu addItemWithTitle:@"Permissions: checking..." action:nil keyEquivalent:@""];
    self.permissionStatusItem.enabled = NO;
    NSMenuItem *openScreenPermissions = [self.menu addItemWithTitle:@"Open Screen Recording Settings" action:@selector(openScreenRecordingSettings:) keyEquivalent:@""];
    openScreenPermissions.target = self;
    NSMenuItem *openCameraPermissions = [self.menu addItemWithTitle:@"Open Camera Settings" action:@selector(openCameraSettings:) keyEquivalent:@""];
    openCameraPermissions.target = self;
    self.requestCameraPermissionItem = [self.menu addItemWithTitle:@"Request Camera Permission" action:@selector(requestCameraPermission:) keyEquivalent:@""];
    self.requestCameraPermissionItem.target = self;
    self.requestNotificationPermissionItem = [self.menu addItemWithTitle:@"Request Notification Permission" action:@selector(requestNotificationPermission:) keyEquivalent:@""];
    self.requestNotificationPermissionItem.target = self;
    NSMenuItem *retestPermissions = [self.menu addItemWithTitle:@"Retest Permissions" action:@selector(retestPermissions:) keyEquivalent:@""];
    retestPermissions.target = self;
    [self.menu addItem:[NSMenuItem separatorItem]];

    self.watchStatusItem = [self.menu addItemWithTitle:@"Visual Watch: idle" action:nil keyEquivalent:@""];
    self.watchStatusItem.enabled = NO;
    self.diffStatusItem = [self.menu addItemWithTitle:@"Last diff: none" action:nil keyEquivalent:@""];
    self.diffStatusItem.enabled = NO;
    self.captureTestItem = [self.menu addItemWithTitle:@"Test Capture Once" action:@selector(testCaptureOnce:) keyEquivalent:@""];
    self.captureTestItem.target = self;
    self.diffEngineTestItem = [self.menu addItemWithTitle:@"Test Diff Engine" action:@selector(testDiffEngine:) keyEquivalent:@""];
    self.diffEngineTestItem.target = self;
    self.watchToggleItem = [self.menu addItemWithTitle:@"Start Visual Watch" action:@selector(toggleWatch:) keyEquivalent:@""];
    self.watchToggleItem.target = self;
    self.notifyOnChangesItem = [self.menu addItemWithTitle:@"Notify on Changes: On" action:@selector(toggleNotifyOnChanges:) keyEquivalent:@""];
    self.notifyOnChangesItem.target = self;

    [self.menu addItem:[NSMenuItem separatorItem]];
    self.recordStatusItem = [self.menu addItemWithTitle:@"Recorder: idle" action:nil keyEquivalent:@""];
    self.recordStatusItem.enabled = NO;
    self.deviceStatusItem = [self.menu addItemWithTitle:@"Devices: checking..." action:nil keyEquivalent:@""];
    self.deviceStatusItem.enabled = NO;
    self.screenRecordItem = [self.menu addItemWithTitle:@"Start Screen Recording" action:@selector(toggleScreenRecording:) keyEquivalent:@""];
    self.screenRecordItem.target = self;
    self.faceRecordItem = [self.menu addItemWithTitle:@"Start Screen + Face" action:@selector(toggleFaceRecording:) keyEquivalent:@""];
    self.faceRecordItem.target = self;
    self.screenTestRecordItem = [self.menu addItemWithTitle:@"Record 3s Screen Test" action:@selector(recordScreenTest:) keyEquivalent:@""];
    self.screenTestRecordItem.target = self;
    self.faceTestRecordItem = [self.menu addItemWithTitle:@"Record 3s Screen + Face Test" action:@selector(recordFaceTest:) keyEquivalent:@""];
    self.faceTestRecordItem.target = self;
    self.cameraTestRecordItem = [self.menu addItemWithTitle:@"Record 3s Face Test" action:@selector(recordCameraOnlyTest:) keyEquivalent:@""];
    self.cameraTestRecordItem.target = self;
    self.recordPlanTestItem = [self.menu addItemWithTitle:@"Test Recording Plan" action:@selector(testRecordingPlan:) keyEquivalent:@""];
    self.recordPlanTestItem.target = self;
    self.stopRecordItem = [self.menu addItemWithTitle:@"Stop Recording" action:@selector(stopRecordingFromUI:) keyEquivalent:@""];
    self.stopRecordItem.target = self;
    self.mirrorItem = [self.menu addItemWithTitle:@"Mirror Face Overlay: On" action:@selector(toggleMirror:) keyEquivalent:@""];
    self.mirrorItem.target = self;

    NSMenuItem *refreshDevices = [self.menu addItemWithTitle:@"Refresh Devices" action:@selector(refreshDevices:) keyEquivalent:@""];
    refreshDevices.target = self;
    NSMenuItem *openRecordings = [self.menu addItemWithTitle:@"Open Recordings" action:@selector(openRecordings:) keyEquivalent:@""];
    openRecordings.target = self;
    NSMenuItem *diagnostics = [self.menu addItemWithTitle:@"Write Diagnostics Report" action:@selector(writeDiagnostics:) keyEquivalent:@""];
    diagnostics.target = self;
    self.selfTestItem = [self.menu addItemWithTitle:@"Run Self-Test" action:@selector(runSelfTest:) keyEquivalent:@""];
    self.selfTestItem.target = self;
    self.loginItem = [self.menu addItemWithTitle:@"Launch at Login: Off" action:@selector(toggleLaunchAtLogin:) keyEquivalent:@""];
    self.loginItem.target = self;

    [self.menu addItem:[NSMenuItem separatorItem]];
    NSMenuItem *quit = [self.menu addItemWithTitle:@"Quit Revere" action:@selector(quit:) keyEquivalent:@""];
    quit.target = self;
}

- (void)menuWillOpen:(NSMenu *)menu {
    (void)menu;
    self.dashboardMenuItem.view = [self dashboardMenuView];
}

- (NSView *)dashboardMenuView {
    static const CGFloat width = 560.0;
    static const CGFloat height = 520.0;
    NSView *view = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, width, height)];
    view.wantsLayer = YES;
    view.layer.backgroundColor = [NSColor colorWithCalibratedWhite:0.08 alpha:1.0].CGColor;

    [view addSubview:[self dashboardTopBar:NSMakeRect(20, 466, 520, 42)]];
    [view addSubview:[self dashboardRule:NSMakeRect(20, 446, 520, 1)]];

    NSString *permission = [self compactPermissionSummary];
    [view addSubview:[self dashboardText:@"Revere"
                                   frame:NSMakeRect(20, 404, 190, 30)
                                    font:[NSFont systemFontOfSize:22 weight:NSFontWeightBold]
                                   color:NSColor.labelColor
                               alignment:NSTextAlignmentLeft]];
    [view addSubview:[self dashboardText:@"Updated just now"
                                   frame:NSMakeRect(20, 382, 190, 22)
                                    font:[NSFont systemFontOfSize:14 weight:NSFontWeightSemibold]
                                   color:NSColor.secondaryLabelColor
                               alignment:NSTextAlignmentLeft]];
    [view addSubview:[self dashboardText:permission
                                   frame:NSMakeRect(238, 384, 302, 46)
                                    font:[NSFont systemFontOfSize:14 weight:NSFontWeightSemibold]
                                   color:NSColor.secondaryLabelColor
                               alignment:NSTextAlignmentRight]];
    [view addSubview:[self dashboardRule:NSMakeRect(20, 364, 520, 1)]];

    [view addSubview:[self dashboardText:@"Visual Watch"
                                   frame:NSMakeRect(20, 324, 240, 30)
                                    font:[NSFont systemFontOfSize:22 weight:NSFontWeightBold]
                                   color:NSColor.labelColor
                               alignment:NSTextAlignmentLeft]];
    double watchProgress = self.watchRunning ? MIN(1.0, (double)MAX(1, self.captureCount) / 10.0) : 0.0;
    [view addSubview:[self dashboardSparkline:NSMakeRect(20, 294, 520, 28) progress:watchProgress]];
    [view addSubview:[self dashboardProgress:NSMakeRect(20, 282, 520, 8) value:watchProgress]];
    NSString *watchLeft = self.watchRunning
        ? [NSString stringWithFormat:@"%ld samples\n%ld changes", (long)self.captureCount, (long)self.changeCount]
        : @"Idle\n0 changes";
    NSString *watchRight = self.watchRunning
        ? @"Sampling every 2s\nKeeps one tiny sample"
        : @"Ready when permitted\nNo disk screenshots";
    [view addSubview:[self dashboardText:watchLeft
                                   frame:NSMakeRect(20, 236, 210, 42)
                                    font:[NSFont systemFontOfSize:15 weight:NSFontWeightBold]
                                   color:NSColor.labelColor
                               alignment:NSTextAlignmentLeft]];
    [view addSubview:[self dashboardText:watchRight
                                   frame:NSMakeRect(330, 236, 210, 42)
                                    font:[NSFont systemFontOfSize:15 weight:NSFontWeightSemibold]
                                   color:NSColor.secondaryLabelColor
                               alignment:NSTextAlignmentRight]];

    [view addSubview:[self dashboardMetricWithTitle:@"Notify"
                                              value:self.notifyOnChanges ? @"On" : @"Off"
                                              frame:NSMakeRect(20, 194, 118, 44)]];
    [view addSubview:[self dashboardMetricWithTitle:@"Mirror"
                                              value:self.mirrorCamera ? @"On" : @"Off"
                                              frame:NSMakeRect(154, 194, 118, 44)]];
    [view addSubview:[self dashboardMetricWithTitle:@"Captures"
                                              value:[NSString stringWithFormat:@"%ld", (long)self.captureCount]
                                              frame:NSMakeRect(288, 194, 118, 44)]];
    [view addSubview:[self dashboardMetricWithTitle:@"Changes"
                                              value:[NSString stringWithFormat:@"%ld", (long)self.changeCount]
                                              frame:NSMakeRect(422, 194, 118, 44)]];

    [view addSubview:[self dashboardRule:NSMakeRect(20, 176, 520, 1)]];
    [view addSubview:[self dashboardText:@"Recorder"
                                   frame:NSMakeRect(20, 136, 240, 30)
                                    font:[NSFont systemFontOfSize:22 weight:NSFontWeightBold]
                                   color:NSColor.labelColor
                               alignment:NSTextAlignmentLeft]];
    NSString *recordStatus = self.recordStatusItem.title ?: @"Recorder: idle";
    NSString *devices = self.deviceStatusItem.title ?: @"Devices: checking...";
    [view addSubview:[self dashboardText:recordStatus
                                   frame:NSMakeRect(20, 106, 520, 24)
                                    font:[NSFont systemFontOfSize:15 weight:NSFontWeightSemibold]
                                   color:NSColor.secondaryLabelColor
                               alignment:NSTextAlignmentLeft]];
    [view addSubview:[self dashboardText:devices
                                   frame:NSMakeRect(20, 82, 520, 24)
                                    font:[NSFont systemFontOfSize:15 weight:NSFontWeightSemibold]
                                   color:NSColor.secondaryLabelColor
                               alignment:NSTextAlignmentLeft]];

    double readiness = 0.25;
    if ([self ffmpegPath]) { readiness += 0.25; }
    if ([self cameraPermissionSummary].length > 0) { readiness += 0.25; }
    if (CGPreflightScreenCaptureAccess()) { readiness += 0.25; }
    [view addSubview:[self dashboardProgress:NSMakeRect(20, 60, 520, 8) value:MIN(1.0, readiness)]];
    [view addSubview:[self dashboardButtonWithTitle:self.watchToggleItem.title ?: @"Start Visual Watch"
                                              frame:NSMakeRect(20, 22, 122, 32)
                                             symbol:self.watchRunning ? @"pause.fill" : @"play.fill"
                                             action:@selector(toggleWatch:)]];
    NSButton *screenButton = [self dashboardButtonWithTitle:self.screenRecordItem.title ?: @"Screen"
                                                      frame:NSMakeRect(152, 22, 112, 32)
                                                     symbol:@"record.circle"
                                                     action:@selector(toggleScreenRecording:)];
    screenButton.enabled = self.screenRecordItem.enabled;
    [view addSubview:screenButton];
    NSButton *faceButton = [self dashboardButtonWithTitle:self.faceRecordItem.title ?: @"Screen + Face"
                                                    frame:NSMakeRect(274, 22, 132, 32)
                                                   symbol:@"person.crop.rectangle"
                                                   action:@selector(toggleFaceRecording:)];
    faceButton.enabled = self.faceRecordItem.enabled;
    [view addSubview:faceButton];
    [view addSubview:[self dashboardButtonWithTitle:@"Run Self-Test"
                                              frame:NSMakeRect(416, 22, 124, 32)
                                             symbol:@"checkmark.seal"
                                             action:@selector(runSelfTest:)]];

    return view;
}

- (NSTextField *)dashboardText:(NSString *)text
                         frame:(NSRect)frame
                          font:(NSFont *)font
                         color:(NSColor *)color
                     alignment:(NSTextAlignment)alignment {
    NSTextField *label = [NSTextField labelWithString:text ?: @""];
    label.frame = frame;
    label.font = font;
    label.textColor = color;
    label.alignment = alignment;
    label.lineBreakMode = NSLineBreakByWordWrapping;
    label.maximumNumberOfLines = 2;
    return label;
}

- (NSView *)dashboardTopBar:(NSRect)frame {
    NSView *bar = [[NSView alloc] initWithFrame:frame];
    bar.wantsLayer = YES;
    bar.layer.cornerRadius = 13.0;
    bar.layer.masksToBounds = NO;
    bar.layer.backgroundColor = [NSColor colorWithCalibratedWhite:0.115 alpha:1.0].CGColor;
    bar.layer.borderColor = [NSColor colorWithCalibratedWhite:0.24 alpha:1.0].CGColor;
    bar.layer.borderWidth = 1.0;

    NSShadow *shadow = [[NSShadow alloc] init];
    shadow.shadowColor = [NSColor colorWithCalibratedWhite:0.0 alpha:0.28];
    shadow.shadowOffset = NSMakeSize(0.0, -1.0);
    shadow.shadowBlurRadius = 10.0;
    bar.shadow = shadow;

    CGFloat segmentWidth = frame.size.width / 3.0;
    [bar addSubview:[self dashboardTopBarButton:@"Overview"
                                           frame:NSMakeRect(4, 4, segmentWidth - 8, 34)
                                          symbol:@"rectangle.grid.2x2"
                                        selected:NO
                                          action:@selector(showControls:)]];
    [bar addSubview:[self dashboardTopBarButton:@"Revere"
                                           frame:NSMakeRect(segmentWidth + 4, 4, segmentWidth - 8, 34)
                                          symbol:@"bolt.circle.fill"
                                        selected:YES
                                          action:@selector(runSelfTest:)]];
    [bar addSubview:[self dashboardTopBarButton:@"Recorder"
                                           frame:NSMakeRect((segmentWidth * 2.0) + 4, 4, segmentWidth - 8, 34)
                                          symbol:@"record.circle"
                                        selected:NO
                                          action:@selector(openRecordings:)]];

    [bar addSubview:[self dashboardTopBarDivider:NSMakeRect(segmentWidth, 9, 1, 24)]];
    [bar addSubview:[self dashboardTopBarDivider:NSMakeRect(segmentWidth * 2.0, 9, 1, 24)]];
    return bar;
}

- (NSButton *)dashboardTopBarButton:(NSString *)title
                              frame:(NSRect)frame
                             symbol:(NSString *)symbolName
                           selected:(BOOL)selected
                             action:(SEL)action {
    NSButton *button = [NSButton buttonWithTitle:title target:self action:action];
    button.frame = frame;
    button.bezelStyle = NSBezelStyleRegularSquare;
    button.bordered = NO;
    button.font = [NSFont systemFontOfSize:16 weight:selected ? NSFontWeightBold : NSFontWeightSemibold];
    button.contentTintColor = selected ? NSColor.whiteColor : NSColor.secondaryLabelColor;
    button.image = [self dashboardSymbol:symbolName accessibility:title];
    button.imagePosition = NSImageLeading;
    button.imageHugsTitle = YES;
    button.toolTip = title;
    button.wantsLayer = YES;
    button.layer.cornerRadius = 10.0;
    button.layer.masksToBounds = YES;
    button.layer.backgroundColor = selected
        ? [NSColor colorWithCalibratedRed:0.03 green:0.45 blue:0.86 alpha:1.0].CGColor
        : [NSColor clearColor].CGColor;

    if (selected) {
        CAGradientLayer *shine = [CAGradientLayer layer];
        shine.frame = button.bounds;
        shine.colors = @[
            (__bridge id)[NSColor colorWithCalibratedRed:0.10 green:0.62 blue:1.0 alpha:1.0].CGColor,
            (__bridge id)[NSColor colorWithCalibratedRed:0.02 green:0.39 blue:0.78 alpha:1.0].CGColor
        ];
        shine.startPoint = CGPointMake(0.0, 1.0);
        shine.endPoint = CGPointMake(1.0, 0.0);
        [button.layer insertSublayer:shine atIndex:0];
    }
    return button;
}

- (NSView *)dashboardTopBarDivider:(NSRect)frame {
    NSView *divider = [[NSView alloc] initWithFrame:frame];
    divider.wantsLayer = YES;
    divider.layer.backgroundColor = [NSColor colorWithCalibratedWhite:1.0 alpha:0.07].CGColor;
    return divider;
}

- (NSView *)dashboardRule:(NSRect)frame {
    NSView *rule = [[NSView alloc] initWithFrame:frame];
    rule.wantsLayer = YES;
    rule.layer.backgroundColor = [NSColor colorWithCalibratedWhite:0.24 alpha:1.0].CGColor;
    return rule;
}

- (NSProgressIndicator *)dashboardProgress:(NSRect)frame value:(double)value {
    NSProgressIndicator *progress = [[NSProgressIndicator alloc] initWithFrame:frame];
    progress.indeterminate = NO;
    progress.minValue = 0.0;
    progress.maxValue = 1.0;
    progress.doubleValue = MAX(0.0, MIN(1.0, value));
    progress.controlSize = NSControlSizeSmall;
    progress.style = NSProgressIndicatorStyleBar;
    if ([progress respondsToSelector:@selector(setContentTintColor:)]) {
        [progress setValue:[NSColor colorWithCalibratedRed:0.33 green:0.75 blue:0.80 alpha:1.0]
                    forKey:@"contentTintColor"];
    }
    return progress;
}

- (NSView *)dashboardSparkline:(NSRect)frame progress:(double)progress {
    NSView *graph = [[NSView alloc] initWithFrame:frame];
    graph.wantsLayer = YES;
    graph.layer.cornerRadius = 7.0;
    graph.layer.backgroundColor = [NSColor colorWithCalibratedWhite:0.105 alpha:1.0].CGColor;

    NSInteger barCount = 28;
    CGFloat gap = 4.0;
    CGFloat barWidth = (frame.size.width - (gap * (barCount - 1))) / barCount;
    double liveScale = self.watchRunning ? 1.0 : 0.38;
    NSInteger activeBars = MAX(1, (NSInteger)ceil(progress * barCount));
    for (NSInteger index = 0; index < barCount; index++) {
        double wave = (sin((double)index * 0.72) + 1.0) / 2.0;
        double pulse = (index % 5 == 0) ? 0.35 : 0.0;
        double heightRatio = 0.18 + ((wave + pulse) * 0.52 * liveScale);
        if (index < self.changeCount % barCount) { heightRatio = MIN(0.95, heightRatio + 0.25); }

        CGFloat barHeight = MAX(3.0, (frame.size.height - 6.0) * heightRatio);
        NSView *bar = [[NSView alloc] initWithFrame:NSMakeRect(index * (barWidth + gap),
                                                               3,
                                                               barWidth,
                                                               barHeight)];
        bar.wantsLayer = YES;
        bar.layer.cornerRadius = 1.5;
        bar.layer.backgroundColor = (self.watchRunning || index < activeBars)
            ? [NSColor colorWithCalibratedRed:0.14 green:0.63 blue:1.0 alpha:0.92].CGColor
            : [NSColor colorWithCalibratedWhite:0.28 alpha:0.55].CGColor;
        [graph addSubview:bar];
    }
    return graph;
}

- (NSView *)dashboardMetricWithTitle:(NSString *)title value:(NSString *)value frame:(NSRect)frame {
    NSView *metric = [[NSView alloc] initWithFrame:frame];
    [metric addSubview:[self dashboardText:title
                                     frame:NSMakeRect(0, 22, frame.size.width, 20)
                                      font:[NSFont systemFontOfSize:13 weight:NSFontWeightBold]
                                     color:NSColor.secondaryLabelColor
                                 alignment:NSTextAlignmentLeft]];
    [metric addSubview:[self dashboardText:value
                                     frame:NSMakeRect(0, 0, frame.size.width, 24)
                                      font:[NSFont monospacedDigitSystemFontOfSize:20 weight:NSFontWeightBold]
                                     color:NSColor.labelColor
                                 alignment:NSTextAlignmentLeft]];
    return metric;
}

- (NSButton *)dashboardButtonWithTitle:(NSString *)title frame:(NSRect)frame symbol:(NSString *)symbolName action:(SEL)action {
    NSButton *button = [NSButton buttonWithTitle:title target:self action:action];
    button.frame = frame;
    button.font = [NSFont systemFontOfSize:12 weight:NSFontWeightBold];
    button.bezelStyle = NSBezelStyleRounded;
    button.image = [self dashboardSymbol:symbolName accessibility:title];
    button.imagePosition = NSImageLeading;
    button.imageHugsTitle = YES;
    button.lineBreakMode = NSLineBreakByTruncatingTail;
    return button;
}

- (NSImage *)dashboardSymbol:(NSString *)symbolName accessibility:(NSString *)description {
    if (!symbolName.length || ![NSImage respondsToSelector:@selector(imageWithSystemSymbolName:accessibilityDescription:)]) {
        return nil;
    }
    NSImage *image = [NSImage imageWithSystemSymbolName:symbolName accessibilityDescription:description];
    image.template = YES;
    return image;
}

- (void)updateMenuState {
    self.permissionStatusItem.title = [self permissionSummary];
    self.watchToggleItem.title = self.watchRunning ? @"Stop Visual Watch" : @"Start Visual Watch";
    if (self.watchRunning) {
        self.watchStatusItem.title = self.watchNeedsPermission
            ? @"Visual Watch: needs Screen Recording permission"
            : @"Visual Watch: running every 2s";
    } else {
        self.watchStatusItem.title = @"Visual Watch: idle";
    }

    BOOL recording = self.recordingTask != nil;
    if (!recording) {
        self.screenRecordItem.title = @"Start Screen Recording";
        self.faceRecordItem.title = @"Start Screen + Face";
        self.screenRecordItem.enabled = YES;
        self.faceRecordItem.enabled = YES;
        self.screenTestRecordItem.enabled = YES;
        self.faceTestRecordItem.enabled = YES;
        self.cameraTestRecordItem.enabled = YES;
        self.recordPlanTestItem.enabled = YES;
        self.stopRecordItem.enabled = NO;
    } else if (self.recordingIncludesFace) {
        self.screenRecordItem.title = @"Screen Recording Busy";
        self.faceRecordItem.title = @"Stop Screen + Face";
        self.screenRecordItem.enabled = NO;
        self.faceRecordItem.enabled = YES;
        self.screenTestRecordItem.enabled = NO;
        self.faceTestRecordItem.enabled = NO;
        self.cameraTestRecordItem.enabled = NO;
        self.recordPlanTestItem.enabled = NO;
        self.stopRecordItem.enabled = YES;
    } else {
        self.screenRecordItem.title = @"Stop Screen Recording";
        self.faceRecordItem.title = @"Screen + Face Busy";
        self.screenRecordItem.enabled = YES;
        self.faceRecordItem.enabled = NO;
        self.screenTestRecordItem.enabled = NO;
        self.faceTestRecordItem.enabled = NO;
        self.cameraTestRecordItem.enabled = NO;
        self.recordPlanTestItem.enabled = NO;
        self.stopRecordItem.enabled = YES;
    }
    self.notifyOnChangesItem.title = self.notifyOnChanges ? @"Notify on Changes: On" : @"Notify on Changes: Off";
    self.mirrorItem.title = self.mirrorCamera ? @"Mirror Face Overlay: On" : @"Mirror Face Overlay: Off";
    self.loginItem.title = [self launchAtLoginEnabled] ? @"Launch at Login: On" : @"Launch at Login: Off";
    [self refreshControlPanel];
}

- (NSString *)compactPermissionSummary {
    NSString *screen = CGPreflightScreenCaptureAccess() ? @"Screen Recording granted" : @"Screen Recording needed";
    return [NSString stringWithFormat:@"%@\n%@", screen, [self cameraPermissionSummary]];
}

- (NSString *)permissionSummary {
    NSString *screen = CGPreflightScreenCaptureAccess() ? @"Screen Recording granted" : @"Screen Recording needed";
    return [NSString stringWithFormat:@"Permissions: %@; %@", screen, [self cameraPermissionSummary]];
}

- (NSString *)cameraPermissionSummary {
    AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo];
    switch (status) {
        case AVAuthorizationStatusAuthorized:
            return @"Camera granted";
        case AVAuthorizationStatusNotDetermined:
            return @"Camera not requested";
        case AVAuthorizationStatusDenied:
        case AVAuthorizationStatusRestricted:
            return @"Camera needed";
    }
    return @"Camera unknown";
}

- (void)openScreenRecordingSettings:(id)sender {
    (void)sender;
    NSURL *url = [NSURL URLWithString:@"x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"];
    [[NSWorkspace sharedWorkspace] openURL:url];
}

- (void)openCameraSettings:(id)sender {
    (void)sender;
    NSURL *url = [NSURL URLWithString:@"x-apple.systempreferences:com.apple.preference.security?Privacy_Camera"];
    [[NSWorkspace sharedWorkspace] openURL:url];
}

- (void)requestCameraPermission:(id)sender {
    (void)sender;
    if ([self cameraAccessReady]) {
        self.recordStatusItem.title = @"Recorder: Camera permission ready";
        [self updateMenuState];
    }
}

- (void)requestNotificationPermission:(id)sender {
    (void)sender;
    UNAuthorizationOptions options = UNAuthorizationOptionAlert | UNAuthorizationOptionSound;
    [[UNUserNotificationCenter currentNotificationCenter] requestAuthorizationWithOptions:options
                                                                       completionHandler:^(BOOL granted, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (granted) {
                self.recordStatusItem.title = @"Notifications: permission granted";
            } else if (error) {
                self.recordStatusItem.title = [NSString stringWithFormat:@"Notifications: %@", error.localizedDescription ?: @"permission failed"];
            } else {
                self.recordStatusItem.title = @"Notifications: permission needed";
            }
            [self updateMenuState];
        });
    }];
}

- (void)retestPermissions:(id)sender {
    (void)sender;
    BOOL screenReady = CGPreflightScreenCaptureAccess();
    if (screenReady) {
        self.watchNeedsPermission = NO;
        if (self.watchRunning && [self.diffStatusItem.title containsString:@"Screen Recording permission"]) {
            self.diffStatusItem.title = @"Last diff: permission granted; waiting for next sample";
        }
    } else if (self.watchRunning) {
        self.watchNeedsPermission = YES;
        self.diffStatusItem.title = @"Last diff: waiting for Screen Recording permission";
    }
    if (!self.recordingTask) {
        self.recordStatusItem.title = screenReady ? @"Recorder: permissions ready" : @"Recorder: needs Screen Recording permission";
    }
    [self updateMenuState];
}

- (void)showControls:(id)sender {
    (void)sender;
    if (!self.controlPanel) {
        [self buildControlPanel];
    }
    [self refreshControlPanel];
    [NSApp activateIgnoringOtherApps:YES];
    [self.controlPanel center];
    [self.controlPanel makeKeyAndOrderFront:self];
    [self.controlPanel orderFrontRegardless];
}

- (void)buildControlPanel {
    self.controlPanel = [[NSPanel alloc] initWithContentRect:NSMakeRect(0, 0, 380, 540)
                                                   styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskUtilityWindow
                                                     backing:NSBackingStoreBuffered
                                                       defer:NO];
    self.controlPanel.title = @"Revere Controls";
    self.controlPanel.releasedWhenClosed = NO;
    self.controlPanel.level = NSFloatingWindowLevel;

    NSStackView *stack = [[NSStackView alloc] initWithFrame:NSMakeRect(18, 18, 344, 504)];
    stack.orientation = NSUserInterfaceLayoutOrientationVertical;
    stack.alignment = NSLayoutAttributeLeading;
    stack.spacing = 10;
    stack.translatesAutoresizingMaskIntoConstraints = NO;
    [self.controlPanel.contentView addSubview:stack];

    NSTextField *title = [NSTextField labelWithString:@"Revere"];
    title.font = [NSFont systemFontOfSize:24 weight:NSFontWeightBold];
    [stack addArrangedSubview:title];

    self.panelPermissionLabel = [self panelLabel:[self permissionSummary]];
    self.panelWatchLabel = [self panelLabel:@"Visual Watch: idle"];
    self.panelDiffLabel = [self panelLabel:@"Last diff: none"];
    self.panelRecordLabel = [self panelLabel:@"Recorder: idle"];
    self.panelDeviceLabel = [self panelLabel:self.deviceStatusItem.title ?: @"Devices: checking..."];

    [stack addArrangedSubview:self.panelPermissionLabel];
    self.panelScreenPermissionButton = [self panelButton:@"Open Screen Recording Settings" action:@selector(openScreenRecordingSettings:)];
    self.panelCameraPermissionButton = [self panelButton:@"Open Camera Settings" action:@selector(openCameraSettings:)];
    self.panelRetestPermissionButton = [self panelButton:@"Retest Permissions" action:@selector(retestPermissions:)];
    [stack addArrangedSubview:self.panelScreenPermissionButton];
    [stack addArrangedSubview:self.panelCameraPermissionButton];
    [stack addArrangedSubview:self.panelRetestPermissionButton];

    NSBox *permissionSeparator = [[NSBox alloc] initWithFrame:NSMakeRect(0, 0, 334, 1)];
    permissionSeparator.boxType = NSBoxSeparator;
    permissionSeparator.translatesAutoresizingMaskIntoConstraints = NO;
    [permissionSeparator.widthAnchor constraintEqualToConstant:334].active = YES;
    [stack addArrangedSubview:permissionSeparator];

    [stack addArrangedSubview:self.panelWatchLabel];
    [stack addArrangedSubview:self.panelDiffLabel];
    self.panelWatchButton = [self panelButton:@"Start Visual Watch" action:@selector(toggleWatch:)];
    [stack addArrangedSubview:self.panelWatchButton];

    NSBox *separator = [[NSBox alloc] initWithFrame:NSMakeRect(0, 0, 334, 1)];
    separator.boxType = NSBoxSeparator;
    separator.translatesAutoresizingMaskIntoConstraints = NO;
    [separator.widthAnchor constraintEqualToConstant:334].active = YES;
    [stack addArrangedSubview:separator];
    [stack addArrangedSubview:self.panelRecordLabel];
    [stack addArrangedSubview:self.panelDeviceLabel];
    self.panelScreenButton = [self panelButton:@"Start Screen Recording" action:@selector(toggleScreenRecording:)];
    self.panelFaceButton = [self panelButton:@"Start Screen + Face" action:@selector(toggleFaceRecording:)];
    self.panelStopButton = [self panelButton:@"Stop Recording" action:@selector(stopRecordingFromUI:)];
    self.panelMirrorButton = [self panelButton:@"Mirror Face Overlay: On" action:@selector(toggleMirror:)];
    NSButton *refreshButton = [self panelButton:@"Refresh Devices" action:@selector(refreshDevices:)];
    NSButton *openButton = [self panelButton:@"Open Recordings" action:@selector(openRecordings:)];
    [stack addArrangedSubview:self.panelScreenButton];
    [stack addArrangedSubview:self.panelFaceButton];
    [stack addArrangedSubview:self.panelStopButton];
    [stack addArrangedSubview:self.panelMirrorButton];
    [stack addArrangedSubview:refreshButton];
    [stack addArrangedSubview:openButton];

    [NSLayoutConstraint activateConstraints:@[
        [stack.leadingAnchor constraintEqualToAnchor:self.controlPanel.contentView.leadingAnchor constant:18],
        [stack.trailingAnchor constraintEqualToAnchor:self.controlPanel.contentView.trailingAnchor constant:-18],
        [stack.topAnchor constraintEqualToAnchor:self.controlPanel.contentView.topAnchor constant:18]
    ]];
}

- (NSTextField *)panelLabel:(NSString *)text {
    NSTextField *label = [NSTextField labelWithString:text];
    label.textColor = NSColor.secondaryLabelColor;
    label.lineBreakMode = NSLineBreakByWordWrapping;
    label.maximumNumberOfLines = 3;
    return label;
}

- (NSButton *)panelButton:(NSString *)title action:(SEL)action {
    NSButton *button = [NSButton buttonWithTitle:title target:self action:action];
    button.bezelStyle = NSBezelStyleRounded;
    button.translatesAutoresizingMaskIntoConstraints = NO;
    [button.widthAnchor constraintEqualToConstant:334].active = YES;
    return button;
}

- (void)refreshControlPanel {
    if (!self.controlPanel) { return; }
    self.panelPermissionLabel.stringValue = self.permissionStatusItem.title ?: [self permissionSummary];
    self.panelWatchLabel.stringValue = self.watchStatusItem.title ?: @"Visual Watch: idle";
    self.panelDiffLabel.stringValue = self.diffStatusItem.title ?: @"Last diff: none";
    self.panelRecordLabel.stringValue = self.recordStatusItem.title ?: @"Recorder: idle";
    self.panelDeviceLabel.stringValue = self.deviceStatusItem.title ?: @"Devices: checking...";
    self.panelWatchButton.title = self.watchToggleItem.title ?: @"Start Visual Watch";
    self.panelScreenButton.title = self.screenRecordItem.title ?: @"Start Screen Recording";
    self.panelScreenButton.enabled = self.screenRecordItem.enabled;
    self.panelFaceButton.title = self.faceRecordItem.title ?: @"Start Screen + Face";
    self.panelFaceButton.enabled = self.faceRecordItem.enabled;
    self.panelStopButton.enabled = self.stopRecordItem.enabled;
    self.panelMirrorButton.title = self.mirrorItem.title ?: @"Mirror Face Overlay: On";
}

- (void)toggleWatch:(id)sender {
    (void)sender;
    if (self.watchRunning) {
        [self stopWatch];
    } else {
        [self startWatch];
    }
}

- (void)startWatch {
    if (self.watchRunning) { return; }
    self.watchRunning = YES;
    self.watchNeedsPermission = !CGPreflightScreenCaptureAccess();
    self.previousSample = nil;
    self.captureCount = 0;
    self.changeCount = 0;
    self.diffStatusItem.title = self.watchNeedsPermission
        ? @"Last diff: waiting for Screen Recording permission"
        : @"Last diff: priming first screenshot";
    [self updateMenuState];
    if (self.watchNeedsPermission) {
        CGRequestScreenCaptureAccess();
    }
    self.watchTimer = [NSTimer scheduledTimerWithTimeInterval:RevereScreenshotInterval
                                                       target:self
                                                     selector:@selector(watchTick:)
                                                     userInfo:nil
                                                      repeats:YES];
    [self watchTick:nil];
}

- (void)stopWatch {
    [self.watchTimer invalidate];
    self.watchTimer = nil;
    self.watchRunning = NO;
    self.watchInFlight = NO;
    self.previousSample = nil;
    self.diffStatusItem.title = @"Last diff: stopped";
    [self updateMenuState];
}

- (void)testCaptureOnce:(id)sender {
    (void)sender;
    if (!CGPreflightScreenCaptureAccess()) {
        self.watchNeedsPermission = YES;
        self.diffStatusItem.title = @"Capture test: needs Screen Recording permission";
        [self updateMenuState];
        CGRequestScreenCaptureAccess();
        return;
    }

    self.watchNeedsPermission = NO;
    self.diffStatusItem.title = @"Capture test: running...";
    [self updateMenuState];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        NSError *error = nil;
        RevereImageSample *sample = [self captureSample:&error];
        dispatch_async(dispatch_get_main_queue(), ^{
            if (!sample) {
                self.watchNeedsPermission = YES;
                self.diffStatusItem.title = [NSString stringWithFormat:@"Capture test: %@", error.localizedDescription ?: @"failed"];
                [self updateMenuState];
                return;
            }

            const unsigned char *pixels = sample.pixels.bytes;
            NSInteger total = sample.width * sample.height;
            unsigned long long sum = 0;
            unsigned char minValue = 255;
            unsigned char maxValue = 0;
            for (NSInteger index = 0; index < total; index++) {
                unsigned char value = pixels[index];
                sum += value;
                minValue = MIN(minValue, value);
                maxValue = MAX(maxValue, value);
            }
            NSInteger average = total > 0 ? (NSInteger)llround((double)sum / (double)total) : 0;
            self.watchNeedsPermission = NO;
            self.diffStatusItem.title = [NSString stringWithFormat:@"Capture test: OK %ldx%ld avg %ld range %u-%u",
                                         (long)sample.width,
                                         (long)sample.height,
                                         (long)average,
                                         minValue,
                                         maxValue];
            [self updateMenuState];
        });
    });
}

- (void)testDiffEngine:(id)sender {
    (void)sender;
    self.diffStatusItem.title = [self diffEngineSelfTestSummary];
    [self updateMenuState];
}

- (NSString *)diffEngineSelfTestSummary {
    RevereImageSample *baseline = [self syntheticSampleWithChangedRect:NSMakeRect(0, 0, 0, 0)];
    RevereImageSample *centerChange = [self syntheticSampleWithChangedRect:NSMakeRect(44, 22, 40, 20)];
    RevereImageSample *edgeNoise = [self syntheticSampleWithChangedRect:NSMakeRect(0, 0, 1, RevereSampleHeight)];

    NSDictionary *centerDiff = [self diffFrom:baseline to:centerChange];
    NSDictionary *edgeDiff = [self diffFrom:baseline to:edgeNoise];
    BOOL centerOK = [self isMeaningfulDiff:centerDiff];
    BOOL edgeOK = ![self isMeaningfulDiff:edgeDiff];
    if (centerOK && edgeOK) {
        NSInteger percent = MAX(1, (NSInteger)llround([centerDiff[@"changedRatio"] doubleValue] * 100.0));
        return [NSString stringWithFormat:@"Diff engine: OK %ld%% center change; edge noise ignored", (long)percent];
    }
    return [NSString stringWithFormat:@"Diff engine: failed center=%@ edge=%@",
                                      centerOK ? @"ok" : @"bad",
                                      edgeOK ? @"ok" : @"bad"];
}

- (RevereImageSample *)syntheticSampleWithChangedRect:(NSRect)rect {
    NSMutableData *pixels = [NSMutableData dataWithLength:(NSUInteger)(RevereSampleWidth * RevereSampleHeight)];
    unsigned char *target = pixels.mutableBytes;
    for (NSInteger index = 0; index < RevereSampleWidth * RevereSampleHeight; index++) {
        target[index] = 24;
    }
    NSInteger minX = MAX(0, (NSInteger)floor(NSMinX(rect)));
    NSInteger minY = MAX(0, (NSInteger)floor(NSMinY(rect)));
    NSInteger maxX = MIN(RevereSampleWidth, (NSInteger)ceil(NSMaxX(rect)));
    NSInteger maxY = MIN(RevereSampleHeight, (NSInteger)ceil(NSMaxY(rect)));
    for (NSInteger y = minY; y < maxY; y++) {
        for (NSInteger x = minX; x < maxX; x++) {
            target[y * RevereSampleWidth + x] = 220;
        }
    }

    RevereImageSample *sample = [[RevereImageSample alloc] init];
    sample.width = RevereSampleWidth;
    sample.height = RevereSampleHeight;
    sample.pixels = pixels;
    return sample;
}

- (void)watchTick:(id)sender {
    (void)sender;
    if (self.watchInFlight) { return; }
    if (!CGPreflightScreenCaptureAccess()) {
        self.watchNeedsPermission = YES;
        self.diffStatusItem.title = @"Last diff: waiting for Screen Recording permission";
        [self updateMenuState];
        return;
    }
    self.watchInFlight = YES;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        NSError *error = nil;
        RevereImageSample *sample = [self captureSample:&error];
        dispatch_async(dispatch_get_main_queue(), ^{
            self.watchInFlight = NO;
            if (!sample) {
                self.watchNeedsPermission = YES;
                self.diffStatusItem.title = [NSString stringWithFormat:@"Last diff: %@", error.localizedDescription ?: @"capture failed"];
                [self updateMenuState];
                return;
            }

            self.watchNeedsPermission = NO;
            self.captureCount += 1;
            RevereImageSample *oldSample = self.previousSample;
            self.previousSample = sample;
            if (!oldSample) {
                self.diffStatusItem.title = [NSString stringWithFormat:@"Last diff: baseline captured (%ld samples)", (long)self.captureCount];
                [self updateMenuState];
                return;
            }

            NSDictionary *diff = [self diffFrom:oldSample to:sample];
            if ([self isMeaningfulDiff:diff]) {
                self.changeCount += 1;
                NSInteger percent = MAX(1, (NSInteger)llround([diff[@"changedRatio"] doubleValue] * 100.0));
                self.diffStatusItem.title = [NSString stringWithFormat:@"Last diff: %ld%% changed, %ld changes, %ld samples", (long)percent, (long)self.changeCount, (long)self.captureCount];
                [self notifyVisualChangeWithPercent:percent];
            } else {
                self.diffStatusItem.title = [NSString stringWithFormat:@"Last diff: no meaningful change, %ld samples", (long)self.captureCount];
            }
            [self updateMenuState];
        });
    });
}

- (RevereImageSample *)captureSample:(NSError **)error {
    typedef CGImageRef (*WindowImageCreateFn)(CGRect, CGWindowListOption, CGWindowID, CGWindowImageOption);
    WindowImageCreateFn createImage = (WindowImageCreateFn)dlsym(RTLD_DEFAULT, "CGWindowListCreateImage");
    if (!createImage) {
        if (error) {
            *error = [NSError errorWithDomain:@"Revere"
                                         code:9
                                     userInfo:@{NSLocalizedDescriptionKey: @"Screen capture API is unavailable."}];
        }
        return nil;
    }

    CGImageRef image = createImage(
        CGRectInfinite,
        kCGWindowListOptionOnScreenOnly,
        kCGNullWindowID,
        kCGWindowImageDefault);
    if (!image) {
        if (error) {
            *error = [NSError errorWithDomain:@"Revere"
                                         code:10
                                     userInfo:@{NSLocalizedDescriptionKey: @"Screen capture returned no image. Check Screen Recording permission."}];
        }
        return nil;
    }

    NSMutableData *pixels = [NSMutableData dataWithLength:(NSUInteger)(RevereSampleWidth * RevereSampleHeight)];
    CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceGray();
    CGContextRef context = CGBitmapContextCreate(
        pixels.mutableBytes,
        RevereSampleWidth,
        RevereSampleHeight,
        8,
        RevereSampleWidth,
        colorSpace,
        kCGImageAlphaNone);

    if (!context) {
        CGColorSpaceRelease(colorSpace);
        CGImageRelease(image);
        if (error) {
            *error = [NSError errorWithDomain:@"Revere"
                                         code:11
                                     userInfo:@{NSLocalizedDescriptionKey: @"Could not create sample bitmap context."}];
        }
        return nil;
    }

    CGContextSetInterpolationQuality(context, kCGInterpolationLow);
    CGContextDrawImage(context, CGRectMake(0, 0, RevereSampleWidth, RevereSampleHeight), image);
    CGContextRelease(context);
    CGColorSpaceRelease(colorSpace);
    CGImageRelease(image);

    RevereImageSample *sample = [[RevereImageSample alloc] init];
    sample.width = RevereSampleWidth;
    sample.height = RevereSampleHeight;
    sample.pixels = pixels;
    return sample;
}

- (NSDictionary *)diffFrom:(RevereImageSample *)oldSample to:(RevereImageSample *)newSample {
    if (oldSample.width != newSample.width || oldSample.height != newSample.height) { return nil; }
    const unsigned char *oldPixels = oldSample.pixels.bytes;
    const unsigned char *newPixels = newSample.pixels.bytes;
    NSInteger total = newSample.width * newSample.height;
    NSInteger changed = 0;
    NSInteger minX = newSample.width;
    NSInteger minY = newSample.height;
    NSInteger maxX = -1;
    NSInteger maxY = -1;
    for (NSInteger index = 0; index < total; index++) {
        if (labs((long)newPixels[index] - (long)oldPixels[index]) < ReverePixelDiffThreshold) { continue; }
        changed += 1;
        NSInteger x = index % newSample.width;
        NSInteger y = index / newSample.width;
        minX = MIN(minX, x);
        minY = MIN(minY, y);
        maxX = MAX(maxX, x);
        maxY = MAX(maxY, y);
    }
    if (changed == 0) { return nil; }
    NSInteger bboxWidth = maxX - minX + 1;
    NSInteger bboxHeight = maxY - minY + 1;
    return @{
        @"changedRatio": @((double)changed / (double)total),
        @"bboxRatio": @((double)(bboxWidth * bboxHeight) / (double)total),
        @"bboxWidthRatio": @((double)bboxWidth / (double)newSample.width),
        @"bboxHeightRatio": @((double)bboxHeight / (double)newSample.height),
        @"minX": @(minX),
        @"minY": @(minY),
        @"maxX": @(maxX),
        @"maxY": @(maxY)
    };
}

- (BOOL)isMeaningfulDiff:(NSDictionary *)diff {
    if (!diff) { return NO; }
    if ([diff[@"changedRatio"] doubleValue] < RevereDiffRatioThreshold) { return NO; }
    if ([diff[@"bboxRatio"] doubleValue] < RevereBboxRatioThreshold) { return NO; }
    NSInteger minX = [diff[@"minX"] integerValue];
    NSInteger minY = [diff[@"minY"] integerValue];
    NSInteger maxX = [diff[@"maxX"] integerValue];
    NSInteger maxY = [diff[@"maxY"] integerValue];
    BOOL leftEdge = minX <= (NSInteger)(RevereSampleWidth * RevereEdgeStripRatio);
    BOOL rightEdge = maxX >= RevereSampleWidth - 1 - (NSInteger)(RevereSampleWidth * RevereEdgeStripRatio);
    BOOL topEdge = minY <= (NSInteger)(RevereSampleHeight * RevereEdgeStripRatio);
    BOOL bottomEdge = maxY >= RevereSampleHeight - 1 - (NSInteger)(RevereSampleHeight * RevereEdgeStripRatio);
    BOOL thinVertical = [diff[@"bboxWidthRatio"] doubleValue] < RevereEdgeStripRatio && (leftEdge || rightEdge);
    BOOL thinHorizontal = [diff[@"bboxHeightRatio"] doubleValue] < RevereEdgeStripRatio && (topEdge || bottomEdge);
    return !(thinVertical || thinHorizontal);
}

- (void)toggleNotifyOnChanges:(id)sender {
    (void)sender;
    self.notifyOnChanges = !self.notifyOnChanges;
    [self saveNotifyOnChangesPreference];
    [self updateMenuState];
}

- (void)notifyVisualChangeWithPercent:(NSInteger)percent {
    if (!self.notifyOnChanges) { return; }
    NSTimeInterval now = [NSDate date].timeIntervalSince1970;
    if (now - self.lastVisualNotificationAt < RevereVisualNotificationCooldown) { return; }
    self.lastVisualNotificationAt = now;

    UNMutableNotificationContent *content = [[UNMutableNotificationContent alloc] init];
    content.title = @"Revere saw a screen change";
    content.body = [NSString stringWithFormat:@"%ld%% of sampled pixels changed.", (long)percent];
    content.sound = [UNNotificationSound defaultSound];
    NSString *identifier = [NSString stringWithFormat:@"revere-visual-change-%lld", (long long)llround(now)];
    UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:identifier
                                                                          content:content
                                                                          trigger:nil];
    [[UNUserNotificationCenter currentNotificationCenter] addNotificationRequest:request withCompletionHandler:nil];
}

- (void)toggleScreenRecording:(id)sender {
    (void)sender;
    if (self.recordingTask) {
        [self stopRecording];
    } else {
        [self startRecordingWithFace:NO];
    }
}

- (void)startScreenRecording:(id)sender {
    (void)sender;
    [self startRecordingWithFace:NO];
}

- (void)toggleFaceRecording:(id)sender {
    (void)sender;
    if (self.recordingTask) {
        [self stopRecording];
    } else {
        [self startRecordingWithFace:YES];
    }
}

- (void)startFaceRecording:(id)sender {
    (void)sender;
    [self startRecordingWithFace:YES];
}

- (void)recordScreenTest:(id)sender {
    (void)sender;
    [self startTimedRecordingWithFace:NO];
}

- (void)recordFaceTest:(id)sender {
    (void)sender;
    [self startTimedRecordingWithFace:YES];
}

- (void)recordCameraOnlyTest:(id)sender {
    (void)sender;
    [self startTimedCameraOnlyRecording];
}

- (void)testRecordingPlan:(id)sender {
    (void)sender;
    self.recordStatusItem.title = @"Recording plan: checking...";
    [self updateMenuState];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        NSString *summary = [self recordingPlanSummary];
        dispatch_async(dispatch_get_main_queue(), ^{
            self.recordStatusItem.title = summary;
            [self updateMenuState];
        });
    });
}

- (void)stopRecordingFromUI:(id)sender {
    (void)sender;
    [self stopRecording];
}

- (NSString *)faceOverlayFilter {
    return self.mirrorCamera ? @"hflip,scale=360:-1" : @"scale=360:-1";
}

- (NSString *)faceOnlyFilter {
    return self.mirrorCamera ? @"hflip,scale=720:-1" : @"scale=720:-1";
}

- (NSString *)recordingPlanSummary {
    NSString *ffmpeg = [self ffmpegPath];
    RevereDeviceInfo *devices = [self discoverDevices];
    NSMutableArray<NSString *> *missing = [NSMutableArray array];
    if (!ffmpeg) { [missing addObject:@"ffmpeg"]; }
    BOOL screenPermissionReady = CGPreflightScreenCaptureAccess();
    if (!devices.screenIndex && screenPermissionReady) { [missing addObject:@"screen device"]; }
    if (!devices.cameraIndex) { [missing addObject:@"camera device"]; }

    NSString *overlayFilter = [self faceOverlayFilter];
    NSString *faceOnlyFilter = [self faceOnlyFilter];
    BOOL mirrorFilterOK = self.mirrorCamera
        ? ([overlayFilter containsString:@"hflip"] && [faceOnlyFilter containsString:@"hflip"])
        : (![overlayFilter containsString:@"hflip"] && ![faceOnlyFilter containsString:@"hflip"]);
    if (!mirrorFilterOK) { [missing addObject:@"mirror filter"]; }

    if (missing.count > 0) {
        return [NSString stringWithFormat:@"Recording plan: blocked (%@)", [missing componentsJoinedByString:@", "]];
    }

    NSString *screenMode = devices.screenIndex ? @"screen" : @"screen permission-gated";
    NSString *faceMode = self.mirrorCamera ? @"mirrored" : @"normal";
    return [NSString stringWithFormat:@"Recording plan: OK %@; screen+face overlay; face %@",
                                      screenMode,
                                      faceMode];
}

- (void)startTimedRecordingWithFace:(BOOL)includeFace {
    if (self.recordingTask) {
        self.recordStatusItem.title = @"Recorder: already recording";
        [self updateMenuState];
        return;
    }

    [self startRecordingWithFace:includeFace];
    NSTask *task = self.recordingTask;
    if (!task) { return; }

    NSString *kind = includeFace ? @"3s screen + face test" : @"3s screen test";
    self.recordStatusItem.title = [NSString stringWithFormat:@"Recorder: %@ running...", kind];
    [self updateMenuState];

    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(3 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        if (self.recordingTask == task) {
            [self stopRecording];
        }
    });
}

- (void)startTimedCameraOnlyRecording {
    if (self.recordingTask) {
        self.recordStatusItem.title = @"Recorder: already recording";
        [self updateMenuState];
        return;
    }
    if (![self cameraAccessReady]) { return; }

    NSString *ffmpeg = [self ffmpegPath];
    if (!ffmpeg) {
        self.recordStatusItem.title = @"Recorder: ffmpeg not found";
        [self updateMenuState];
        return;
    }
    RevereDeviceInfo *devices = [self discoverDevices];
    if (!devices.cameraIndex) {
        self.recordStatusItem.title = @"Recorder: no camera device";
        [self updateMenuState];
        return;
    }

    [[NSFileManager defaultManager] createDirectoryAtPath:RevereRecordingsDirectory() withIntermediateDirectories:YES attributes:nil error:nil];
    NSString *output = [RevereRecordingsDirectory() stringByAppendingPathComponent:[NSString stringWithFormat:@"Revere-face-test-%@.mp4", RevereTimestamp()]];
    NSArray<NSString *> *args = @[
        @"-y", @"-hide_banner",
        @"-f", @"avfoundation",
        @"-framerate", @"30",
        @"-i", [NSString stringWithFormat:@"%@:none", devices.cameraIndex],
        @"-vf", [self faceOnlyFilter],
        @"-c:v", @"libx264",
        @"-preset", @"veryfast",
        @"-crf", @"23",
        @"-pix_fmt", @"yuv420p",
        @"-movflags", @"+faststart",
        output,
    ];

    [self launchRecordingWithFFmpeg:ffmpeg
                          arguments:args
                             output:output
                       includesFace:YES
                            message:@"Recorder: 3s mirrored face test running..."];
    NSTask *task = self.recordingTask;
    if (!task) { return; }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(3 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        if (self.recordingTask == task) {
            [self stopRecording];
        }
    });
}

- (void)startRecordingWithFace:(BOOL)includeFace {
    if (!CGPreflightScreenCaptureAccess()) {
        self.recordStatusItem.title = @"Recorder: needs Screen Recording permission";
        [self updateMenuState];
        CGRequestScreenCaptureAccess();
        return;
    }
    if (includeFace && ![self cameraAccessReady]) {
        return;
    }

    NSString *ffmpeg = [self ffmpegPath];
    if (!ffmpeg) {
        self.recordStatusItem.title = @"Recorder: ffmpeg not found";
        [self updateMenuState];
        return;
    }
    RevereDeviceInfo *devices = [self discoverDevices];
    if (!devices.screenIndex) {
        self.recordStatusItem.title = @"Recorder: no screen capture device";
        [self updateMenuState];
        return;
    }
    if (includeFace && !devices.cameraIndex) {
        self.recordStatusItem.title = @"Recorder: no camera device";
        [self updateMenuState];
        return;
    }

    [[NSFileManager defaultManager] createDirectoryAtPath:RevereRecordingsDirectory() withIntermediateDirectories:YES attributes:nil error:nil];
    NSString *kind = includeFace ? @"screen-face" : @"screen";
    NSString *output = [RevereRecordingsDirectory() stringByAppendingPathComponent:[NSString stringWithFormat:@"Revere-%@-%@.mp4", kind, RevereTimestamp()]];
    NSMutableArray<NSString *> *args = [NSMutableArray arrayWithArray:@[
        @"-y", @"-hide_banner",
        @"-f", @"avfoundation",
        @"-framerate", @"30",
        @"-i", [NSString stringWithFormat:@"%@:none", devices.screenIndex],
    ]];

    if (includeFace) {
        [args addObjectsFromArray:@[
            @"-f", @"avfoundation",
            @"-framerate", @"30",
            @"-i", [NSString stringWithFormat:@"%@:none", devices.cameraIndex],
            @"-filter_complex", [NSString stringWithFormat:@"[1:v]%@[cam];[0:v][cam]overlay=W-w-24:H-h-24[v]", [self faceOverlayFilter]],
            @"-map", @"[v]",
        ]];
    }

    [args addObjectsFromArray:@[
        @"-c:v", @"libx264",
        @"-preset", @"veryfast",
        @"-crf", @"23",
        @"-pix_fmt", @"yuv420p",
        @"-movflags", @"+faststart",
        output,
    ]];

    NSString *message = includeFace
        ? [NSString stringWithFormat:@"Recorder: screen + mirrored face -> %@", output.lastPathComponent]
        : [NSString stringWithFormat:@"Recorder: screen -> %@", output.lastPathComponent];
    [self launchRecordingWithFFmpeg:ffmpeg
                          arguments:args
                             output:output
                       includesFace:includeFace
                            message:message];
}

- (void)launchRecordingWithFFmpeg:(NSString *)ffmpeg
                         arguments:(NSArray<NSString *> *)args
                            output:(NSString *)output
                      includesFace:(BOOL)includeFace
                           message:(NSString *)message {
    NSTask *task = [[NSTask alloc] init];
    NSPipe *inputPipe = [NSPipe pipe];
    task.launchPath = ffmpeg;
    task.arguments = args;
    task.standardInput = inputPipe;
    task.standardOutput = [NSPipe pipe];
    task.standardError = [NSPipe pipe];
    @try {
        [task launch];
        self.recordingTask = task;
        self.recordingInput = inputPipe;
        self.recordingPath = output;
        self.recordingIncludesFace = includeFace;
        self.recordingPID = task.processIdentifier;
        __weak typeof(self) weakSelf = self;
        task.terminationHandler = ^(NSTask *finishedTask) {
            dispatch_async(dispatch_get_main_queue(), ^{
                __strong typeof(weakSelf) self = weakSelf;
                if (!self || self.recordingTask != finishedTask) { return; }
                NSString *finishedPath = self.recordingPath;
                self.recordingTask = nil;
                self.recordingInput = nil;
                self.recordingPath = nil;
                self.recordingIncludesFace = NO;
                self.recordingPID = 0;
                self.recordStatusItem.title = [self recordingFinishedMessageForPath:finishedPath status:finishedTask.terminationStatus];
                [self updateMenuState];
            });
        };
        self.recordStatusItem.title = message;
        [self updateMenuState];
    } @catch (NSException *exception) {
        self.recordStatusItem.title = [NSString stringWithFormat:@"Recorder: %@", exception.reason ?: @"failed to start"];
        [self updateMenuState];
    }
}

- (BOOL)cameraAccessReady {
    AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo];
    if (status == AVAuthorizationStatusAuthorized) {
        return YES;
    }
    if (status == AVAuthorizationStatusNotDetermined) {
        self.recordStatusItem.title = @"Recorder: waiting for Camera permission";
        [self updateMenuState];
        [AVCaptureDevice requestAccessForMediaType:AVMediaTypeVideo completionHandler:^(BOOL granted) {
            dispatch_async(dispatch_get_main_queue(), ^{
                self.recordStatusItem.title = granted
                    ? @"Recorder: Camera permission granted; start again"
                    : @"Recorder: needs Camera permission";
                [self updateMenuState];
            });
        }];
        return NO;
    }
    self.recordStatusItem.title = @"Recorder: needs Camera permission";
    [self updateMenuState];
    return NO;
}

- (void)stopRecording {
    NSTask *task = self.recordingTask;
    NSString *path = self.recordingPath;
    NSPipe *inputPipe = self.recordingInput;
    if (!task) { return; }
    self.recordStatusItem.title = @"Recorder: stopping...";
    [self refreshControlPanel];
    pid_t pid = task.processIdentifier > 0 ? task.processIdentifier : self.recordingPID;
    @try {
        [[inputPipe fileHandleForWriting] writeData:[@"q\n" dataUsingEncoding:NSUTF8StringEncoding]];
        [[inputPipe fileHandleForWriting] closeFile];
    } @catch (NSException *exception) {
        (void)exception;
    }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1 * NSEC_PER_SEC)), dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        if (task.isRunning && pid > 0) {
            kill(pid, SIGINT);
        }
    });
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(5 * NSEC_PER_SEC)), dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        if (task.isRunning && pid > 0) {
            kill(pid, SIGTERM);
        }
    });
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(8 * NSEC_PER_SEC)), dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        if (task.isRunning && pid > 0) {
            kill(pid, SIGKILL);
        }
    });
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        if (task.isRunning) {
            [task waitUntilExit];
        }
        dispatch_async(dispatch_get_main_queue(), ^{
            if (self.recordingTask != task) { return; }
            self.recordingTask = nil;
            self.recordingInput = nil;
            self.recordingPath = nil;
            self.recordingIncludesFace = NO;
            self.recordingPID = 0;
            self.recordStatusItem.title = [self recordingFinishedMessageForPath:path status:task.terminationStatus];
            [self updateMenuState];
        });
    });
}

- (NSString *)recordingFinishedMessageForPath:(NSString *)path status:(int)status {
    NSDictionary *attributes = path ? [[NSFileManager defaultManager] attributesOfItemAtPath:path error:nil] : nil;
    unsigned long long fileSize = [attributes fileSize];
    if (fileSize > 0) {
        return [NSString stringWithFormat:@"Recorder: saved %@", path.lastPathComponent ?: @"recording"];
    }
    if (status == 0) {
        return @"Recorder: stopped; no frames captured";
    }
    return [NSString stringWithFormat:@"Recorder: stopped; no frames captured (status %d)", status];
}

- (void)toggleMirror:(id)sender {
    (void)sender;
    self.mirrorCamera = !self.mirrorCamera;
    [self saveMirrorCameraPreference];
    [self updateMenuState];
}

- (void)refreshDevices:(id)sender {
    (void)sender;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        RevereDeviceInfo *devices = [self discoverDevices];
        dispatch_async(dispatch_get_main_queue(), ^{
            NSString *screen = devices.screenName ?: @"screen unavailable";
            NSString *camera = devices.cameraName ?: @"camera unavailable";
            self.deviceStatusItem.title = [NSString stringWithFormat:@"Devices: %@ + %@", screen, camera];
            [self refreshControlPanel];
        });
    });
}

- (void)runSelfTest:(id)sender {
    (void)sender;
    self.recordStatusItem.title = @"Self-test: running...";
    [self updateMenuState];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        NSString *summary = [self selfTestSummary];
        dispatch_async(dispatch_get_main_queue(), ^{
            self.recordStatusItem.title = summary;
            [self updateMenuState];
        });
    });
}

- (NSString *)selfTestSummary {
    RevereDeviceInfo *devices = [self discoverDevices];
    NSString *diffStatus = [[self diffEngineSelfTestSummary] containsString:@"OK"] ? @"diff OK" : @"diff failed";
    NSString *ffmpegStatus = [self ffmpegPath] ? @"ffmpeg OK" : @"ffmpeg missing";
    NSString *screenStatus = devices.screenIndex ? @"screen device OK" : @"screen device missing";
    NSString *cameraStatus = devices.cameraIndex ? @"camera OK" : @"camera missing";
    NSString *mirrorStatus = self.mirrorCamera ? @"mirror on" : @"mirror off";
    NSString *notifyStatus = self.notifyOnChanges ? @"notify on" : @"notify off";
    NSString *planStatus = [[self recordingPlanSummary] containsString:@"OK"] ? @"record plan OK" : @"record plan blocked";
    NSString *captureStatus = @"capture needs permission";
    if (CGPreflightScreenCaptureAccess()) {
        NSError *error = nil;
        RevereImageSample *sample = [self captureSample:&error];
        captureStatus = sample
            ? [NSString stringWithFormat:@"capture OK %ldx%ld", (long)sample.width, (long)sample.height]
            : [NSString stringWithFormat:@"capture failed: %@", error.localizedDescription ?: @"unknown"];
    }
    return [NSString stringWithFormat:@"Self-test: %@; %@; %@; %@; %@; %@; %@; %@",
                                      diffStatus,
                                      captureStatus,
                                      screenStatus,
                                      cameraStatus,
                                      ffmpegStatus,
                                      planStatus,
                                      notifyStatus,
                                      mirrorStatus];
}

- (RevereDeviceInfo *)discoverDevices {
    RevereDeviceInfo *devices = [[RevereDeviceInfo alloc] init];
    NSString *ffmpeg = [self ffmpegPath];
    if (!ffmpeg) { return devices; }
    int status = 0;
    NSString *output = RevereRunTask(ffmpeg, @[@"-hide_banner", @"-f", @"avfoundation", @"-list_devices", @"true", @"-i", @""], YES, &status);
    BOOL inVideo = NO;
    NSRegularExpression *regex = [NSRegularExpression regularExpressionWithPattern:@"\\[(\\d+)\\]\\s+(.+)$" options:0 error:nil];
    for (NSString *line in [output componentsSeparatedByCharactersInSet:[NSCharacterSet newlineCharacterSet]]) {
        if ([line containsString:@"AVFoundation video devices"]) {
            inVideo = YES;
            continue;
        }
        if ([line containsString:@"AVFoundation audio devices"]) {
            inVideo = NO;
            continue;
        }
        if (!inVideo) { continue; }
        NSTextCheckingResult *match = [regex firstMatchInString:line options:0 range:NSMakeRange(0, line.length)];
        if (!match || match.numberOfRanges < 3) { continue; }
        NSString *index = [line substringWithRange:[match rangeAtIndex:1]];
        NSString *name = [line substringWithRange:[match rangeAtIndex:2]];
        if ([name.lowercaseString containsString:@"capture screen"]) {
            if (!devices.screenIndex) {
                devices.screenIndex = index;
                devices.screenName = name;
            }
        } else if (!devices.cameraIndex) {
            devices.cameraIndex = index;
            devices.cameraName = name;
        }
    }
    return devices;
}

- (NSString *)ffmpegPath {
    NSArray<NSString *> *paths = @[@"/opt/homebrew/bin/ffmpeg", @"/usr/local/bin/ffmpeg", @"/usr/bin/ffmpeg"];
    for (NSString *path in paths) {
        if ([[NSFileManager defaultManager] isExecutableFileAtPath:path]) {
            return path;
        }
    }
    return nil;
}

- (void)openRecordings:(id)sender {
    (void)sender;
    [[NSFileManager defaultManager] createDirectoryAtPath:RevereRecordingsDirectory() withIntermediateDirectories:YES attributes:nil error:nil];
    [[NSWorkspace sharedWorkspace] openURL:[NSURL fileURLWithPath:RevereRecordingsDirectory() isDirectory:YES]];
}

- (void)writeDiagnostics:(id)sender {
    (void)sender;
    NSString *path = RevereDiagnosticsPath();
    NSString *directory = [path stringByDeletingLastPathComponent];
    [[NSFileManager defaultManager] createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:nil];

    RevereDeviceInfo *devices = [self discoverDevices];
    NSString *bundlePath = [NSBundle mainBundle].bundlePath ?: @"unknown";
    NSString *ffmpeg = [self ffmpegPath] ?: @"not found";
    int codesignStatus = 0;
    NSString *codesignOutput = RevereRunTask(@"/usr/bin/codesign", @[@"--verify", @"--deep", @"--strict", bundlePath], YES, &codesignStatus);
    NSDateFormatter *formatter = [[NSDateFormatter alloc] init];
    formatter.dateFormat = @"yyyy-MM-dd HH:mm:ss ZZZZZ";

    NSMutableString *report = [NSMutableString string];
    [report appendFormat:@"Revere Diagnostics\n"];
    [report appendFormat:@"Generated: %@\n", [formatter stringFromDate:[NSDate date]]];
    [report appendFormat:@"Bundle: %@\n", bundlePath];
    [report appendFormat:@"Code signature: %@\n", codesignStatus == 0 ? @"OK" : [NSString stringWithFormat:@"failed (%d)", codesignStatus]];
    [report appendFormat:@"Launch at login: %@\n", [self launchAtLoginEnabled] ? @"on" : @"off"];
    if (codesignOutput.length > 0) {
        [report appendFormat:@"Code signature output:\n%@\n", codesignOutput];
    }
    [report appendString:@"\nPermissions\n"];
    [report appendFormat:@"%@\n", [self permissionSummary]];
    [report appendString:@"\nDevices\n"];
    [report appendFormat:@"Screen: %@ [%@]\n", devices.screenName ?: @"unavailable", devices.screenIndex ?: @"none"];
    [report appendFormat:@"Camera: %@ [%@]\n", devices.cameraName ?: @"unavailable", devices.cameraIndex ?: @"none"];
    [report appendString:@"\nRecording\n"];
    [report appendFormat:@"ffmpeg: %@\n", ffmpeg];
    [report appendFormat:@"Recordings folder: %@\n", RevereRecordingsDirectory()];
    [report appendFormat:@"Recording active: %@\n", self.recordingTask ? @"yes" : @"no"];
    [report appendFormat:@"Current recording path: %@\n", self.recordingPath ?: @"none"];
    [report appendFormat:@"Mirror camera: %@\n", self.mirrorCamera ? @"on" : @"off"];
    [report appendFormat:@"%@\n", [self recordingPlanSummary]];
    [report appendString:@"\nVisual Watch\n"];
    [report appendFormat:@"Running: %@\n", self.watchRunning ? @"yes" : @"no"];
    [report appendFormat:@"Needs permission: %@\n", self.watchNeedsPermission ? @"yes" : @"no"];
    [report appendFormat:@"Capture count: %ld\n", (long)self.captureCount];
    [report appendFormat:@"Change count: %ld\n", (long)self.changeCount];
    [report appendFormat:@"Notify on changes: %@\n", self.notifyOnChanges ? @"on" : @"off"];
    [report appendFormat:@"%@\n", self.diffStatusItem.title ?: @"Last diff: none"];
    [report appendString:@"\nSelf-Test\n"];
    [report appendFormat:@"%@\n", [self selfTestSummary]];

    NSError *writeError = nil;
    if (![report writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:&writeError]) {
        self.recordStatusItem.title = [NSString stringWithFormat:@"Diagnostics: %@", writeError.localizedDescription ?: @"write failed"];
        [self updateMenuState];
        return;
    }

    self.recordStatusItem.title = @"Diagnostics: report written";
    [self updateMenuState];
    [[NSWorkspace sharedWorkspace] openURL:[NSURL fileURLWithPath:path]];
}

- (BOOL)launchAtLoginEnabled {
    return [[NSFileManager defaultManager] fileExistsAtPath:RevereLaunchAgentPath()];
}

- (void)toggleLaunchAtLogin:(id)sender {
    (void)sender;
    if ([self launchAtLoginEnabled]) {
        [self disableLaunchAtLogin];
    } else {
        [self enableLaunchAtLogin];
    }
    [self updateMenuState];
}

- (void)enableLaunchAtLogin {
    NSString *path = RevereLaunchAgentPath();
    NSString *directory = [path stringByDeletingLastPathComponent];
    NSString *bundlePath = [NSBundle mainBundle].bundlePath ?: @"/Applications/Revere.app";
    [[NSFileManager defaultManager] createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:nil];
    NSString *plist = [NSString stringWithFormat:
        @"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
         "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\"\n"
         "  \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n"
         "<plist version=\"1.0\">\n"
         "<dict>\n"
         "  <key>Label</key>\n"
         "  <string>dev.revere.menubar</string>\n"
         "  <key>ProgramArguments</key>\n"
         "  <array>\n"
         "    <string>/usr/bin/open</string>\n"
         "    <string>-a</string>\n"
         "    <string>%@</string>\n"
         "  </array>\n"
         "  <key>RunAtLoad</key>\n"
         "  <true/>\n"
         "</dict>\n"
         "</plist>\n",
        bundlePath];
    NSError *error = nil;
    if (![plist writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:&error]) {
        self.recordStatusItem.title = [NSString stringWithFormat:@"Launch at Login: %@", error.localizedDescription ?: @"failed"];
        return;
    }
    RevereRunTask(@"/bin/launchctl", @[@"bootout", [NSString stringWithFormat:@"gui/%u", getuid()], path], YES, nil);
    int status = 0;
    NSString *output = RevereRunTask(@"/bin/launchctl", @[@"bootstrap", [NSString stringWithFormat:@"gui/%u", getuid()], path], YES, &status);
    self.recordStatusItem.title = status == 0 ? @"Launch at Login: enabled" : [NSString stringWithFormat:@"Launch at Login: %@", output.length ? output : @"enable failed"];
}

- (void)disableLaunchAtLogin {
    NSString *path = RevereLaunchAgentPath();
    RevereRunTask(@"/bin/launchctl", @[@"bootout", [NSString stringWithFormat:@"gui/%u", getuid()], path], YES, nil);
    NSError *error = nil;
    if ([[NSFileManager defaultManager] fileExistsAtPath:path] &&
        ![[NSFileManager defaultManager] removeItemAtPath:path error:&error]) {
        self.recordStatusItem.title = [NSString stringWithFormat:@"Launch at Login: %@", error.localizedDescription ?: @"disable failed"];
        return;
    }
    self.recordStatusItem.title = @"Launch at Login: disabled";
}

- (void)quit:(id)sender {
    (void)sender;
    [self stopWatch];
    if (self.recordingTask) { [self stopRecording]; }
    [NSApp terminate:nil];
}

@end

int main(int argc, const char *argv[]) {
    (void)argc;
    (void)argv;
    @autoreleasepool {
        NSApplication *app = [NSApplication sharedApplication];
        RevereAppDelegate *delegate = [[RevereAppDelegate alloc] init];
        app.delegate = delegate;
        [app run];
    }
    return 0;
}
